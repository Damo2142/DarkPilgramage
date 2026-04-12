#!/usr/bin/env python3
"""Add Parts 1-5 content to session-0.json"""
import json

with open('config/session-0.json', 'r') as f:
    d = json.load(f)

# Observations linked to existing timed events
new_obs = [
    {"eventId": "katya_crossroads_inn", "items": [
        {"id": "obs-1745-henryk", "tier": 2, "dc": 13, "text": "The merchant's face changed when she started singing."},
        {"id": "obs-1745-vlad", "tier": 2, "dc": 11, "text": "The man in the corner didn't react at all."}]},
    {"eventId": "katya_three_travelers", "items": [
        {"id": "obs-1805-vlad", "tier": 2, "dc": 11, "text": "He felt nothing about a story that should disturb anyone."}]},
    {"eventId": "katya_piotr_lament", "items": [
        {"id": "obs-1835-marta", "tier": 2, "dc": 10, "text": "She left before the second verse. She knew that song was about her."},
        {"id": "obs-1835-katya", "tier": 2, "dc": 14, "text": "The minstrel didn't look at the innkeeper once."}]},
    {"eventId": "katya_pallid_hart", "items": [
        {"id": "obs-1845-gregor", "tier": 2, "dc": 11, "text": "He nodded. He saw it and still came tonight."},
        {"id": "obs-1845-katya", "tier": 2, "dc": 14, "text": "She knows exactly what she's looking at."}]},
    {"eventId": "fire_gutter_18_30", "items": [
        {"id": "obs-1830-fire", "tier": 2, "dc": 13, "text": "The cold came up through the floorboards, not from any door."}]},
    {"eventId": "outside_shape_18_50", "items": [
        {"id": "obs-1850-shape", "tier": 2, "dc": 19, "text": "Wrong proportions for any animal you have a name for."}]},
    {"eventId": "cellar_sound_18", "items": [
        {"id": "obs-1800-cellar", "tier": 2, "dc": 16, "text": "Something moved below. Trying not to."}]},
    {"eventId": "cellar_chain_21", "items": [
        {"id": "obs-2100-chain", "tier": 2, "dc": 15, "text": "Chains. Below the floor. Not free."}]},
    {"eventId": "upstairs_footsteps_18_20", "items": [
        {"id": "obs-1820-up", "tier": 2, "dc": 12, "text": "Whoever is up there doesn't want to be heard."}]},
    {"eventId": "roof_impact_21_30", "items": [
        {"id": "obs-2130-roof", "tier": 2, "dc": 14, "text": "Something landed on the roof. Too heavy for wind."}]},
    {"eventId": "shutter_scratches_23", "items": [
        {"id": "obs-2300-scratches", "tier": 2, "dc": 11, "text": "Three scratches. Deliberate. Then silence."}]}
]
d["world"]["observations"].extend(new_obs)

# New timed events
new_te = [
    {"id": "vlad_food_1735", "gameTime": "1274-10-15T17:35:00", "event": "ambient:observation", "data": {"npcId": "hooded-stranger", "npcName": "The stranger", "text": "has not touched his food.", "durationMs": 30000}},
    {"id": "aldous_drinks_1740", "gameTime": "1274-10-15T17:40:00", "event": "ambient:observation", "data": {"npcId": "aldous-kern", "npcName": "Aldous Kern", "text": "ordered two drinks. Nobody across from him.", "durationMs": 30000}},
    {"id": "gregor_door_1735", "gameTime": "1274-10-15T17:35:00", "event": "ambient:observation", "data": {"npcId": "patron-farmer", "npcName": "Old Gregor", "text": "watches the door. Past afraid. Resigned.", "durationMs": 30000}},
    {"id": "tomas_watch_1800", "gameTime": "1274-10-15T18:00:00", "event": "ambient:observation", "data": {"npcId": "tomas", "npcName": "Tomas", "text": "glancing at back door. Agitated.", "durationMs": 30000}},
    {"id": "henryk_vlad_1815", "gameTime": "1274-10-15T18:15:00", "event": "ambient:observation", "data": {"npcId": "patron-merchant", "npcName": "Henryk", "text": "glancing at corner table. Uncomfortable.", "durationMs": 30000}},
    {"id": "tomas_losing_2100", "gameTime": "1274-10-15T21:00:00", "event": "dm:whisper", "data": {"text": "Tomas has one hour before moonrise. He needs the cellar.", "priority": 2, "category": "story"}},
    {"id": "wolf_approach_2000", "gameTime": "1274-10-15T20:00:00", "event": "dm:whisper", "data": {"text": "Wolf at the door. Alone. Scouting. Pack at tree line.", "priority": 3, "category": "atmosphere"}},
    {"id": "corpse_candle_midnight", "gameTime": "1274-10-16T00:00:00", "event": "dm:whisper", "data": {"text": "Corpse Candle appears. Circuits room. Pauses near Tomas. DC 6. Do not let them attack it.", "priority": 1, "category": "story"}},
    {"id": "rats_exodus_2300", "gameTime": "1274-10-15T23:00:00", "event": "dm:whisper", "data": {"text": "Rats coming down from above. Something worse up there.", "priority": 3, "category": "atmosphere"}}
]
d["world"]["timedEvents"].extend(new_te)

# Creature behaviors
d["creatureBehaviors"] = {
    "tomas": {"behaviorLoop": True, "checkIntervalSec": 300, "currentState": "nervous",
        "stateProgression": [{"time": "17:30", "state": "nervous"},{"time": "19:00", "state": "agitated"},{"time": "20:00", "state": "struggling"},{"time": "21:00", "state": "losing_control"},{"time": "22:00", "state": "transform_imminent"}],
        "perceptionByState": {"nervous": {"dc": 12, "text": "Losing track."}, "agitated": {"dc": 11, "text": "Watching the clock."}, "struggling": {"dc": 10, "text": "Sweating."}, "losing_control": {"dc": 9, "text": "Trying to leave."}, "transform_imminent": {"dc": 8, "text": "His eyes are wrong."}}},
    "wolves": {"behaviorLoop": True, "checkIntervalSec": 60, "count": 4, "currentState": "distant",
        "stateProgression": [{"time": "17:30", "state": "distant"},{"time": "19:30", "state": "curious"},{"time": "20:30", "state": "present"},{"time": "23:00", "state": "aggressive"}],
        "distanceByState": {"distant": 200, "curious": 60, "present": 40, "aggressive": 20}},
    "piotr": {"behaviorLoop": True, "checkIntervalSec": 600, "currentState": "dormant", "chainLength": 8,
        "stateProgression": [{"time": "17:30", "state": "dormant"},{"time": "19:00", "state": "restless"},{"time": "21:00", "state": "active"},{"time": "23:00", "state": "desperate"}]},
    "gasSpore": {"behaviorLoop": True, "checkIntervalSec": 600, "driftRateFtPerMin": 0.1},
    "kamenny": {"behaviorLoop": True, "checkIntervalSec": 120, "circuitDurationMin": 120},
    "letavec": {"behaviorLoop": True, "checkIntervalSec": 60, "circuitIntervalMin": 13},
    "corpseCandle": {"behaviorLoop": False, "triggerTime": "00:00"},
    "rats": {"behaviorLoop": True, "checkIntervalSec": 300, "avoids": "room5"}
}

# Scenes — session-0.json has scenes as a list, not a dict
if "scenes" not in d or not isinstance(d["scenes"], list):
    d["scenes"] = []
# Remove any existing shed/room5 entries
d["scenes"] = [s for s in d["scenes"] if not isinstance(s, dict) or s.get("id") not in ("shed", "room5")]
shed_scene = {
    "id": "shed", "name": "The Shed", "triggerWindow": {"start": "19:30", "end": "20:30"},
    "manualTrigger": True,
    "beats": [
        {"id": "shed-1", "dc": 10, "low": "The cold is immediate.", "mid": "Inn sounds farther away.", "high": "Something out here is very still."},
        {"id": "shed-2", "dc": 11, "low": "Tracks aren't human.", "mid": "Circle the shed.", "high": "Three times. Stood there."},
        {"id": "shed-3", "dc": 12, "low": "Door is open.", "mid": "No wind to move it.", "high": "Something not moving inside."},
        {"id": "shed-4", "dc": 8, "low": "Something under canvas.", "mid": "Wrong shape.", "high": "Canvas too still. Holding its breath."},
        {"id": "shed-5", "dc": 14, "low": "Something moved.", "mid": "Gargoyle moved.", "high": "Looking at you since you walked in."},
        {"id": "shed-6", "takesSkeleton": "One step. Between you and door.", "leavesSkeleton": "Looks away."},
        {"id": "shed-7", "dc": 13, "low": "Something flew over.", "mid": "Wingspan wrong.", "high": "Membrane wings. Horse-sized. Two seconds."}
    ],
    "contents": [
        {"id": "firewood", "dc": 0}, {"id": "silver-dagger", "dc": 8, "itemKey": True},
        {"id": "holy-water-x3", "dc": 8, "itemKey": True}, {"id": "stakes-x6", "dc": 8, "itemKey": True},
        {"id": "healers-kit", "dc": 8}, {"id": "pieter-journal", "dc": 8},
        {"id": "goat-carcass", "dc": 10}, {"id": "wall-marks", "dc": 14}
    ]
}
d["scenes"].append(shed_scene)
room5_scene = {
    "id": "room5", "name": "Pieter's Room",
    "entryText": "Cold. Candle gone. Pack half unpacked. Man in the bed.",
    "maxWhisper": "Everything they need is in that pack.",
    "contents": [
        {"id": "silver-dagger-r5", "dc": 8, "itemKey": True}, {"id": "holy-water-r5", "dc": 8, "itemKey": True},
        {"id": "stakes-r5", "dc": 8, "itemKey": True}, {"id": "healers-kit-r5", "dc": 8},
        {"id": "journal-r5", "dc": 8}, {"id": "map-r5", "dc": 14}
    ],
    "pieter": {"medicineDC10": "Dead for hours. No wounds. That's wrong.", "medicineDC15": "Something drained him."},
    "ratsAvoid": True
}
d["scenes"].append(room5_scene)

with open('config/session-0.json', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)

total_checks = sum(len(o["items"]) for o in new_obs)
print(f"SUCCESS: {len(new_obs)} obs ({total_checks} checks), {len(new_te)} events, 8 creatures, 2 scenes")
