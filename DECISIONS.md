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

## 2026-11-14 — Voices and team chat ready by default

- User asked for the neural voices (and team chat, shown as "Loading…") to be downloaded and loaded by default. Codex had already started both loads on page open. Measured in Chrome: the 1.09 GB team chat weights are cached only after a complete download, so leaving or reloading early restarted it from 0%. Progress also read "Downloading" while loading from the cache, so every visit looked like a download.
- `npm run dev` now saves the model files to a git-ignored `models/` folder first (`scripts/fetch-models.mjs`, 18 files, 1.4 GB, skipped once present; failures never block the dev server). The dev and preview servers serve them at `/models/` with byte ranges. The workers route Hugging Face URLs for saved files to the local copies, including kokoro-js's hard-coded voice URLs. When every needed file is local they skip the browser cache, so the models are not stored twice. `models/` never enters `dist/`, so a deployed site keeps downloading from Hugging Face.
- The voices load before team chat, so they don't compete for bandwidth and the GPU. Labels say "Loading … from this computer" or "Loading", not "Downloading".
- Measured in a brand-new Chrome profile: voices ready in 5.4 s and team chat in 13.5 s, with 0.5 MB written to browser storage. Before this, the first visit downloaded about 1.5 GB.
- Not saved locally: the q4 team chat build for GPUs without shader-f16 (1.7 GB). Those browsers still download it. The WebGPU ONNX runtime still comes from its CDN and the browser's HTTP cache.

## 2026-11-14 — Radio dropouts and voice input accuracy

- **Radio stopping mid-race.** Could not reproduce headless: Chrome CPU voices for 8 min, Chrome GPU for 4 min, and WebKit (Safari's engine) with GPU voices and team chat replying, with no dropout. Code review found three ways the radio went silent for the rest of a race. (1) A render timeout or worker crash reset the voices, and text-until-ready (added the same day) then dropped every later line, with nothing reloading the model. (2) A broken model (for example, a lost GPU) failed every render without ever being rebuilt. (3) A clip whose `onended` never fired held the radio forever, which happens when Safari suspends or interrupts audio output (device switch, another app). Fixes: renders are timed from when the worker starts them, not while queued. A timeout, crash or two failed renders in a row reload the voices in the background, with text radio in the meantime; a second dropout on the GPU switches to the CPU voices, and after three the radio stops retrying and says so. Each clip has a guard of its length plus 2 s, and suspended or interrupted output is resumed. Every path has a test.
- **Voice input accuracy.** Benchmarked with 400 synthetic race calls: 25 calls × 8 macOS English voices (US, UK ×2, Indian ×2, Australian, Irish, South African), clean and with pink noise at 10 dB SNR. Each transcript is scored by whether `parseIntent` and `parseAnswer` give the same call as the script. Prompt changes were judged on a second, differently worded set of 25 calls. Results:
  - Whisper tiny.en as shipped: 52% clean / 26% noisy.
  - base.en, a larger model: no better (51% / 27%).
  - A decoder prompt with the radio vocabulary, roster surnames included: 86% / 68%, and 87% / 72% on the held-out set.
  - Parser fixes: "Ok, do it" was read as a question; "fox", "harts" and "car du" are now repaired.
  - A "box" whose tyre was misheard now asks "Which tyre?" instead of fitting the default set. Wrong commands executed went from 5% to 2% on the held-out set, and "softs" in reply completes the stop.
  - Without the rival names in the prompt, overall accuracy was similar, but rival questions dropped from 69% to 28%, so the names stay.
  - Synthetic voices are a proxy for real players; real accents, microphones and rooms will differ.
- The Whisper files are now part of `npm run models`, so speech recognition loads from this computer too.

## 2026-11-14 — Stay free: on-device voices for the public site

- The user chose to keep the free, on-device setup for now. Hosted voices (HOSTED_VOICE_PLAN.md) are deferred.
- Cost estimate kept for when that changes. Usage was measured with the conversation engine at 1×: 190–250 characters of team speech per minute of play, about 10 s of player audio, and up to 1.3 free-form questions. Prices were read from official pages on 2026-11-14.
  - Budget (OpenAI tts-1, gpt-4o-mini-transcribe, Claude Haiku 5.5): about $0.27 per player-hour.
  - Deepgram Aura-2 and Nova-3 with Claude Haiku 5.5: about $0.51.
  - ElevenLabs Flash and Scribe with Claude Sonnet 5.5: about $0.92.
  - Per-session-minute voice agents (Deepgram Voice Agent, $0.075/min): about $4.50, because they bill silence too.
  - 40% of synthesized characters repeat word for word, so caching rendered lines would cut the voice bill by at least that much.
- Verified the production build as a static site on a first visit with no saved models. Voices downloaded from Hugging Face and were ready in 19 s on this connection, speech recognition passed its check, and the race radio spoke. The only hosts contacted were the site, Google Fonts, Hugging Face's CDN and jsDelivr (the WebGPU ONNX runtime). A host that answers unknown paths with the HTML page (as `vite preview` and many static hosts do) is correctly treated as having no local models.

## 2026-11-14 — Team setup required on capable devices; text radio on phones

- The user rejected making team chat opt-in: neural voices and team chat are required on capable devices, with an animation until both are downloaded and set up. Phones and weak devices get text radio plus the recorded team clips.
- Device check (`src/team-setup.ts`): phones and tablets (including iPads that report a Mac user agent), browsers without a WebGPU adapter or with only a software one, and devices reporting under 4 GB of memory get text radio. Everything else gets the full radio. The player can override with "Load voices and team chat anyway" (remembered per browser) or `?radio=full|lite`.
- Start lights: five lights fill with combined progress, weighted by download size (voices about 25%, team chat about 75%). Progress counts bytes of the large weight files only, because team chat's 150 KB model graph finishes first and had read as 100%. When the team is ready the lights go out and the start button unlocks. The old "Start now" escape is gone; a failed load offers retry, race with text radio, or race without team chat, so no one is trapped.
- Text radio downloads nothing: no voice or team chat worker starts (checked in a browser with a forced lite radio and an emulated iPhone). Lines without a recorded clip stay text and never hold the race.
- Verified in Chrome: full setup from this computer reached ready in about 12 s with the bar rising steadily; text radio and the emulated iPhone started at once; with GPU access disabled and the full radio forced, the voices fell back to the CPU, team chat failed with its reason, and "Race without team chat" unlocked the start.

## 2026-11-14 — Public site on GitHub Pages

- The user asked for a URL to play online. The repository is public, so the game is published free on GitHub Pages at https://rajvardhan19.github.io/F1RaceEngineer/. The Codex-managed private hosting manifest (`.openai/hosting.json`) is unchanged.
- Pages serves the game under `/F1RaceEngineer/`, so asset paths that assumed the site root (recorded clips, voice-check sample, the voice runtime in both workers, the local-models lookup) now use Vite's base URL (`src/base.ts`). Locally the base is still `/`.
- First attempt pushed the built site to a `gh-pages` branch. GitHub push protection blocked it: `Mistral3ForConditionalGeneration`, a 32-character model class name in transformers.js next to the word "Mistral", matched its Mistral API key pattern. None of the project's own code mentions Mistral. Rather than override the check, the user chose to build on GitHub: `.github/workflows/pages.yml` runs the tests, builds with the Pages base path, and deploys on every push to `main`.
- Verified the subpath build as a first-time player: lights out after 85 s (1.4 GB from Hugging Face on this connection), voice check passed, ready again after a reload, and a race with voices and a team chat reply; no failed requests or errors.

## 2026-11-15 — Site at /pitwall/; radio lines that never played

- Renamed the GitHub repository to `pitwall`, so the site is https://rajvardhan19.github.io/pitwall/; the workflow builds for the repository name. The old `/F1RaceEngineer/` address no longer serves the game, while GitHub redirects git operations on the old repository URL.
- User report: team lines appeared as text but were never heard, and the radio showed "preparing" again and again. Measured with radio counters (lines offered, heard, stale, cut, render time) in a 3-minute race at 5×. GPU voices render about 0.6 s per sentence (4-5× faster than speech) in Chrome and WebKit; CPU voices about 7.8 s (2.9× slower), with only 63% of lines heard and gaps up to 33 s. Two causes:
  - Lines expired while their voice rendered. The race keeps running at 1×, most lines live 12-20 race seconds, and a slow render outlived the line, which was then dropped and the next one began "preparing". Now a line at the front of the queue does not age while its own voice renders, so it always plays.
  - Every player input (quick replies included) ran a full radio interrupt that discarded all queued team lines. Now an answer or typed call cuts only the line on air; the microphone still interrupts everything.
- "Preparing … radio" appears only when a voice takes over a second (it had flashed before every line, even on fast GPUs).
- A saved CPU-voices preference now expires after a day, and earlier ones are ignored (new key): a one-off stall had kept Safari on the slow voices for good. The GPU stall guard waits 45 s instead of 20, since the first GPU render compiles shaders. If a browser still ends up on CPU voices, the setup panel says the radio will sound late, and why.
- After the fixes (WebKit): GPU voices 93% of lines heard (the rest cut by the player's replies), no stale drops, "preparing" shown twice in 2 minutes instead of every line. CPU voices: no stale drops, but still about 3× slower than speech.
- Tried multi-threaded CPU voices through cross-origin isolation (COOP/COEP): 4 threads made Chrome's CPU voices 2.2× faster (1.34× real time), but WebKit then refused the team chat worker's module imports on the dev server, breaking team chat in Safari. Reverted; not shipped.
- Not testable from here: the user's actual Safari (remote automation is off). Playwright's WebKit build loads and runs the GPU voices from Hugging Face without stalls.
- Live-site follow-up (WebKit, nothing cached): one run ended on CPU voices (device `wasm`, 56% heard) while the next run, from the same build, stayed on the GPU (86-91% heard; the rest were lines the player's answers cut). A 503 appeared during one load. Any error during the GPU load (a momentary network failure included) made the worker fall back to CPU voices, and the page then remembered CPU for a day. Now download failures are retried twice and then reported, so setup offers "Retry voices". The worker sends the reason with any CPU fallback, and the page remembers CPU only for a real GPU fault (error, silent test render, no adapter).
- The GPU stall guard (45 s) now covers only the silent set-up after the download (shader compilation, test render), never the network. Model loads (voices and team chat) fail only after 90/120 s without progress, instead of a fixed 4/15 minutes, so a slow but steady 1 GB download on a slow connection is never cut off.
- WebKit logged "Cache API … Quota exceeded" for the 1 GB team chat model in Playwright's throwaway profiles. Unverified in real Safari: if its quota is as small, every visit would download team chat again.

## 2026-11-16 — Radio panel, less repetitive radio, pit-wall sounds

- Radio panel: the message list was a fixed 272 px inside a panel that stretches with the timing tower, leaving a dead band (user's screenshot). It now fills the panel (`flex:1 1 0`, 272 px minimum) without growing the page; checked at 1366×768, 1440×900 and 1920×1080, scenario and 22-car race.
- Repetition: measured over 5 races (207 race minutes), 27% of spoken lines repeated a wording already used that race; the worst family 8 times. Most families had two wordings, alternated. Now the most frequent families have 3–6 wordings, several adding state (rival tyre age, laps left), and `pick()` uses each once in a seeded shuffle before repeating, never the same twice in a row. Result: 12%, at most 3 per family per race.
- Sound: the engine drone (two low sawtooth oscillators) is replaced by what a pit wall hears. Our car passes the wall at each lap: a V6 at rpm/20 Hz with a Doppler drop c/(c−v) to c/(c+v), stereo sweep and air-absorption filter. The field passes further away, and the safety car is slower and lower. New pit-stop sound when either car pits: limiter stutter, four wheel guns off and on, jack drop, launch. Checked by rendering offline: the measured pitch ratio was 1.65 against 1.62 expected at 80 m/s; no clipping.
