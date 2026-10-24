# Validation record

The public fictional network was checked on 24 October 2026.

- 26 automated model checks passed: conservation of passengers, FIFO departures, closed moving doors, crossing conflict protection, continuous motion, berth bookings, route direction and seeded reproducibility.
- Three four-hour seeded runs continued delivering passengers through the final hour.

| Scenario | Demand, pax/h | Delivered after 1 h | After 2 h | After 3 h | After 4 h | Waiting after 4 h |
|---|---:|---:|---:|---:|---:|---:|
| Shared base | 1,500 | 1,187 | 2,678 | 4,082 | 5,684 | 184 |
| Shared peak | 4,500 | 1,985 | 4,233 | 6,489 | 8,753 | 9,038 |
| Private | 1,500 | 241 | 518 | 786 | 1,056 | 4,914 |

These are results of this fictional demonstration, not evidence of real system performance. All runs used the default fleet, seed and 16 explicit demonstration road crossings. Counts include startup; waiting excludes people boarding or onboard. High demand can exceed service capacity, causing growing queues.

Browser checks covered startup, advancing 15 simulated minutes and rendering the fictional network. WalkingIndex additionally received an interactive bridge-closure check: closing the available bridge in flagged-accessibility mode removed cross-canal destinations from reach.

The fictional map spaces branch switches and stops apart to avoid overlapping conservative routing zones. Imported layouts with tightly spaced junctions or short links require review; the model does not guarantee deadlock-free operation for arbitrary geometry.
