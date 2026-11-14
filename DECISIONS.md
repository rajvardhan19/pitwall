# Implementation decisions

## 2026-11-12 — First playable prototype

- Treat the supplied design as product context, not as instructions overriding the user's request.
- Build in the existing nested Git checkout, preserving its GitHub origin.
- Use TypeScript + Vite with no runtime UI dependencies. The simulation is testable separately from rendering.
- Start with one fictional Barcelona scenario, ten cars, and two player drivers. Do not present generated performance as historical race data.
- Keep race outcomes authoritative in the seeded fixed-step simulation. Speech parsing never invents an outcome.
- Resolve ambiguity before issuing commands; preserve explicit car context; handle possessives and negated pit orders.
- Snapshot the whole field at sector boundaries. Independently stale positions caused false zero-second gaps during browser QA and were replaced by synchronized snapshots.
- Model pits as stationary time loss at a lap boundary; traffic and safety-car pace turn this into an approximate effective gap loss. Teammate arrivals can queue. This is a strategy approximation, not a spatial pit lane.
- Use real-time speeds of 1×/5×/15×/60×, return to 1× on flag changes, and pause when the tab is hidden.
- Use a same-seed, no-calls full-race baseline in the debrief. Avoid suggesting it measures the isolated effect of any one decision.
- Keep voice optional with text/button parity. Do not require API keys. Do not silently enable microphone or speech playback.
- Defer historical-data licensing, wet-weather modelling, deep trust/credibility, and LLM integration until this core loop is playtested.

## 2026-11-13 — Voice reliability, race presentation, meaningful debrief

- Observed the user's live radio log reporting a browser speech-service `network` error before any transcript. Added local Whisper transcription instead of repeatedly retrying the same service. Browser recognition remains selectable.
- Keep audio capture explicit, bounded, cancellable, and local in on-device mode. Download model files only when voice/check is requested. Include a synthetic audio check without microphone access or race effects.
- Use the synchronous ONNX WASM build in a dedicated worker, self-hosted below static-host per-file limits. The unused large asyncify fallback is omitted from deployment output. Preparation copies runtime files from the locked dependency; generated runtime files are ignored in Git.
- Add differentiated radio profiles, proactive simulator-grounded driver/engineer calls, procedural sound, pit projections and safety-car bunching. No generated audio assets or model output controls simulation outcomes.
- Share constructor colors across the map and timing tower. Add unique driver numbers, inspectable legend, and collision-separated map markers tethered to true track positions.
- Replace the misleading no-pit/no-calls baseline with a deterministic wear-aware default engineer that pits both cars.
- Evaluate 441 one-stop compound/lap pairs in a worker, plus the default, actual run, and valid per-call shifts. Rank by objectives, then points, then total finish time. Explicitly label search coverage and hindsight limits.
- Shift calls by one lap of the driver's original distance/time trace, not a fixed number of seconds. Preserve other call times and disclose reordered/conflicting commands and unavailable shifts.
- Key random noise to car/tick and stop variation to car/stop number so counterfactuals share stochastic conditions instead of consuming a shuffled global random stream.

## Local neural radio
- User explicitly chose free local neural voices over paid hosted TTS. Replace system speech synthesis with Kokoro q8 on WASM; no keys or per-call charges. Download only after opting into headset audio or a voice preview.
- Use stable character casting, modest pace differences, real audio filtering and compression, bounded priority queues, PCM caching, and generation tokens to discard interrupted calls. Never silently fall back to robotic system voices.
- Provide voice previews and visible loading/error states. Hold-Space capture cancels if released before microphone readiness, and loses capture on window blur.

## 2026-11-13 — Conversational pit wall

- The radio felt like a stream of status updates: drivers asked questions nobody could answer, repeated themselves, and stayed silent through the race's big moments. Moved all radio prose out of the simulation into a conversation layer; the simulation now emits structured events only. Race outcomes are unchanged (verified identical finishing times against the previous build).
- Questions to the player are first-class: deadline, quick replies, yes/no parsing, in-character timeouts that never issue commands. Questions return the race to 1×.
- Keep “car one and car two box” as a clarification (earlier decision); double stacks need explicit words (“box both”, “double stack”).
- Negation binds only to the order that follows it (“not now, box next lap” boxes). “Can you box?” is an order, not a question.
- Added a `swap` team-order command to the simulation, recorded and replayable like other calls.
- Radio staleness is measured in race time, so 15×/60× never voice outdated gaps. Synthesis is prefetched and cancellable.
- User chose an in-browser model for open conversation. Evaluated Qwen2.5-0.5B, SmolLM2-360M, Qwen3-0.6B and Gemma-3-1B on the real prompt. Model-proposed commands were wrong on 4 of 10 test phrases for Qwen2.5-0.5B and 9 of 10 for SmolLM2, so the model is chat-only. In the browser, Qwen2.5-0.5B looped at q4f16 (half-precision overflow) and drifted off persona at q4 (“time for some rest”); on CPU it took ~10 s per reply. Llama-3.2-1B q4f16 on WebGPU stayed in persona and referenced the facts, at ~1–1.5 s per reply, so it is the team chat model. WebGPU only: a slow, weak reply hurts immersion more than the scripted answer it would replace. Ungrounded numbers are filtered; greedy decoding, no repetition penalty (it pushed the model away from the fact sheet).

## 2026-11-13 — Faster radio, more team input

- The player felt a delay and wanted more from the team. Measured it in Chrome instead of guessing: Kokoro q8 on single-thread WASM rendered ~3× slower than real time (9 s for a 3 s line, 22.6 s for a tyre answer), and 4 of 13 lines went stale unheard. Only pre-rendered cues were instant.
- Voices render on WebGPU when available (fp32): 0.14–0.41 render-to-speech ratio, 0–3 s to air, nothing dropped. fp16 on WebGPU produced silent audio (checked by transcribing renders with Whisper), so the worker probes audibility at load and falls back to the CPU voice. Accepting a one-time 310 MB download on GPU devices for real-time speech.
- Speak long lines sentence by sentence; start loading live voices at the briefing.
- More talk only after speech kept up: chatter is state-grounded (gap trends, personal bests, dirty air, teammate check, field update, lap picture, tyre warm-up, quiet-minute check-in), spaced by max(30, 12×speed) race seconds, never over an open question.
- Strategy proposals are questions with recorded calls on “yes” only; nothing happens on “no” or silence. James backs off to statements after two ignored questions. Measured (simulated race, answering player): 2.0 → 3.7 voiced lines per race minute; longest silence 339 → 77 s; strategist lines 3 → 14.

## Live-radio reliability
- The user confirmed bundled opening audio works but later conversations are missing. Preserve Claude's expanded conversation and GPU voice work; fix delivery rather than add more text.
- Synchronize simulation advancement with local radio synthesis. Hold while preparing, advance at 1× during playback, then restore the selected acceleration. This sacrifices fast-forward throughput to keep the team audible on slower devices.
- Remove wall-clock expiry during valid rendering, limit sentence prefetch, validate every generated clip, and surface failures by pausing the race. Hosted speech remains budget-gated.

## 2026-11-14 — More scenarios and full races

- User asked for more scenarios and full-race options. Turned the single hard-coded race into data (`RaceConfig`): every module reads laps, pace, pit loss, overtaking difficulty, wear, safety cars, weather and objectives from the race. The Barcelona scenario is unchanged (identical finishing times, laps, stops and events across 12 seed/strategy combinations against the previous build).
- Five circuits; one curated late-race scenario each, plus full races from the grid at sprint, half or full distance with chosen starting tyres. Full-race safety cars and rain come from the seed, so replays stay exact.
- Tuned every scenario with strategy sweeps until doing nothing misses a goal and a specific decision meets both. First drafts failed that test: Monza was unwinnable (no plan won) and Monaco was won by doing nothing. Adjusted grids, tyre ages and objectives until each had a distinct winning call.
- Added a track-position rule for rivals where passing is nearly impossible (overtake threshold ≥ 1.5 s/lap): they skip a safety-car stop if their tyres reach the flag. Barcelona unaffected.
- Added a simplified wet model (track wetness, intermediates, overheating on a drying line, rivals switching at different moments) for the rain scenario and seeded Silverstone showers. Full wets are not modelled; asking for them gets an “inters only” reply.
- Objectives can be a position or “finish ahead of a rival” (title decider); the team’s language, the debrief and the dashboard follow the objective.
- The team does not propose slick stops with rain minutes away, does not ask to attack on the opening lap of a full race, and reviews the start after lap one.

## 2026-11-14 — Fifteen scenarios, a 22-car grid and Season 2026

- User asked for 15 scenarios and a full 2026 season "with all teams and drivers with slight adjustment to avoid direct copy". Lightly altered real names still point at real people and teams (and their trademarks and liveries), so the grid is fully fictional instead: 11 teams and 22 drivers in `src/roster.ts`, one editable file. The size and shape match the 2026 field (11 teams, two cars each). Ids 0–9 keep the original scenario drivers so earlier scenarios replay exactly.
- Venues and the calendar are real: 23 rounds, from Melbourne (8 Mar) to Yas Marina. Source: the [Crash.net 2026 calendar](https://www.crash.net/f1/news/1073119/1/2026-f1-calendar-full-race-schedule-revealed), checked against [Formula 1's calendar announcement](https://www.formula1.com/en/latest/article/formula-1-reveals-calendar-for-2026-season.YctbMZWqBvrgyddrnauo8.YctbMZWqBvrgyddrnauo8). Sources disagreed: the Bahrain and Saudi Arabian rounds were cancelled, and the Bahrain GP replacement at Sepang appeared only in the Crash.net list ([ESPN's schedule](https://www.espn.com/f1/story/_/id/47313408/) was internally inconsistent). Treat round 16 and the late-season dates as best available, not authoritative. The calendar is one array in `src/scenarios.ts`.
- Circuit numbers (lap count, lap time, pit loss, overtaking difficulty, wear, temperatures, safety-car and rain chances) are approximations chosen for strategy, not measured data. Five circuits keep their hand-drawn outlines; the other 18 get a generated smooth loop, labelled schematic, rather than a traced copy of the real layout.
- Ten new scenarios, tuned with the same sweep as the first five. None of the first drafts passed the "doing nothing loses, a real call wins" test as written. For example, at Interlagos Theo's tyres died before the storm arrived (he now starts on hards), and Nico won Las Vegas by doing nothing (he now starts on 28-lap-old hards). Other fixes changed grids and objectives: Spa became a podium target, and Hungary a one-two with Nico winning. Stories were then rewritten to describe the calls that actually win. `tests/season.test.ts` checks each scenario both ways.
- Added an optional cold-tyre warm-up per circuit (extra time on a fresh set's first lap). Only Las Vegas uses it, so earlier races are unchanged.
- Full races and the season use all 22 cars: pace = team car pace + driver skill + a small seeded per-circuit bias; qualifying adds seeded noise. Ten cars stay in scenarios, where the authored grids depend on them.
- Season mode: 23 rounds in order at one distance, F1 points (25…1), drivers ranked by points, wins, then podiums. Each round's seed comes from the season seed, so results do not depend on play order. Unplayed rounds can be simulated with the default engineer (the debrief baseline), about 0.3 s for a whole season. State is saved in `localStorage`; a race abandoned mid-way records nothing, and only the next round can be recorded.
- Balance: in simulated seasons the player's team (Apex) first won the constructors' title with the default engineer alone. Car pace was cut from −0.42 to −0.3 s/lap so Apex finishes around fourth unless the player out-strategises the field.
- Season radio: the team opens each round with the championship picture (round, Grand Prix, both drivers' positions and the gap to the leader). In round one the radio says the season starts now, and the season panel says everyone is on zero instead of showing championship positions.

## 2026-11-14 — Races stuck at "Team radio connected"

- User reported races not starting: the start button sat on "Team radio connected · live reports load on this device". Start waited for the full neural voice load with no limit short of the 4-minute request timeout, and the GPU start-up and voice test sent no progress, so a stalled load looked frozen. The user was running Safari 26.6, which offers WebGPU; the GPU voice path had only been tested in Chrome. Reproduced in Chrome by holding the WebGPU runtime's CDN connection open: the status froze exactly as reported.
- Fix: the worker reports each loading phase; a 20 s no-progress watchdog on the GPU load restarts the worker on the CPU voices and remembers that per browser (keyed to the user agent, so a browser update retries the GPU). A **Start now** button is offered while connecting. With `textUntilReady`, lines that need the live model stay text until it loads, so a slow load never holds the race; bundled clips still play. The director's default (wait for the model) is unchanged for other callers and tests.
- Kept: the headset start still waits for the voices by default (Chrome with a cached model starts in ~4 s), so the full-audio experience is unchanged where the GPU path works. Safari's GPU behaviour itself was not tested directly (no Safari automation without enabling remote automation), so the watchdog decides per browser.
