# Computer Access Mode and the local brain: implementation report

Branch `ccr-3670aed0-joz4xe`. Every result below comes from a real run. The commands to reproduce each one are listed in section D.

## A. What was implemented

### Computer Access Mode (`server/computer/`)

| File | Role |
|---|---|
| `manager.ts` | The single gate: on/off toggle, observe/interact/extended levels, STOP and abort. Guards critical actions, tracks live state, runs probe-backed capability reports. Also handles observe, control, `clickText`, apps and files, and browser operations. |
| `browser.ts` | Drives the user's Chromium-family browser over a **loopback** DevTools port. A method **allowlist** blocks Network, Storage, DOMStorage, IndexedDB, Cache, Fetch, Browser and Target. Page extractors are fixed and read-only. Clicks are trusted input events. It reads page roles, names, states, dialogs, captions and sign-in walls, and refuses password fields. Every action is verified by observing before and after. Supports dropdown `select`. |
| `executor.ts` | Multi-step workflows: observe → act → verify → recover. Only steps that cannot have taken effect are retried, never a click or typing. Stops at a sign-in wall, a covering dialog, an unverifiable step or a critical step, and reports where to resume. |
| `guard.ts` | Classifies critical actions (send, publish, purchase, transfer, legal agreement, delete, install, security settings, admin, private sharing, Enter in a composer). Quarantines prompt injection found in screen or page text. Redacts credentials. |
| `activity.ts` + migration 7 | Live state machine (IDLE … LEARNING … WAITING_FOR_APPROVAL … ERROR), a persistent `computer_actions` audit log, and single-use confirmations that expire after 5 minutes. |
| `input.ts` | X11 (xdotool): move, click, type, keys, scroll, drag, mouse down/up, window minimize/maximize/restore/resize/move/close. **Windows**: user32 through PowerShell. **macOS**: osascript and cliclick. |
| `screen-elements.ts`, `apps.ts` | An OCR element finder (word grouping, tolerant of OCR noise) and an application launcher that never goes through a shell. |
| `watch.ts`, `learning.ts` | "Watch this and learn": change-driven sessions from the browser or the screen. Detects lesson changes, scrolls automatically, moves to the next lesson and follows live captions. Stores verbatim FACT/INFERENCE/UNCERTAIN notes with attribution in the **existing memory**. Saves progress for "continue where you left off" and reports what it could not access. |
| `skills.ts` | Thirteen skills: `computer.browser(_read)`, `click_text`, `find_on_screen`, `app`, `workflow`, `watch`, `recall`, … Critical inputs need the **user's own approval even under Full Access**; this is enforced in `permissions/engine.ts`, `skills/runner.ts` and `tasks/engine.ts`. |

**UI:** a top-bar chip showing OFF or the live state and level, a one-click **STOP**, and a panel showing the task, active app, learning session, pending confirmations (*Allow once* / *Refuse*), browser connection and action log. Settings has the toggle, level, browser endpoint and sampling interval.

### Local brain: switching from Roamies to OpenJarvis (`server/llm/`)

| File | Role |
|---|---|
| `openjarvis.ts` | OpenAI-compatible client for `jarvis serve`. Runs the tool loop with Jarvis's own tools, so every action still goes through Jarvis's permission engine. Strips `<think>` blocks and recovers tool calls a small model writes as text. Detects cloud models by owner (e.g. `nim`). Local Whisper `transcribe` and Kokoro `synthesize`. |
| `engine.ts` | New `brain.backend` (**`openjarvis`**, the default, or `roamies`). **Local-only mode** refuses cloud models, the OpenAI transcription route, Fish Audio and remote "custom" servers. |
| `profiles.ts`, `scripts/jarvis-local.ts` | GEEKOM A6 profiles for 32 GB and 64 GB (model tags and sizes checked in the Ollama registry, all tool-capable), OpenJarvis config generation, the 24/7 Ollama environment and a health `check`. |
| `scripts/local-setup/setup-windows.ps1`, `setup-linux.sh` | One-command setup: Ollama, OpenJarvis pinned to the tested commit, the spaCy model Kokoro needs, the model download, building Jarvis, and logon tasks or systemd services. |
| `app.ts`, `RoamiesGate.tsx` | Roamies is required **only** when the Roamies brain is selected. The lock screen offers "Run fully local with OpenJarvis instead". |
| Voice (`web/src/lib/voice.tsx`) | Local Kokoro voice. In local-only mode, listening always uses local Whisper (never Chrome's cloud recognition). A **local "Hey Jarvis" wake word** transcribes only when speech is detected. |

## B. Computer-control capabilities in practice

Everything here was verified with real OS integration, not mocks. The details are in E and the test files.

- **See:** screenshot, OCR, window list, active window, and an on-screen injection warning.
- **Mouse:** move (position read back), click, double and right click, drag (end point read back), press and hold, scroll. On Linux each was cross-checked by the page reacting.
- **Keyboard:** typing (cross-checked against the field's value), key chords, Enter-to-submit.
- **Windows:** switching (active window read back), resizing (actual size read back).
- **Browser:** tabs, navigation, reading the page's controls, clicking, typing, checkboxes, dropdowns, tabs, menus, dialogs, scrolling, slow pages, sign-in detection, password refusal.
- **Verification is honest:** a dead button is reported *unverified*, never as success. A click on an element covered by a dialog is refused.
- **Safety:** clicking "Send message" waits for the user even with Full Access on. After *Allow once*, exactly one click runs. Cookies and storage are unreachable even from a raw DevTools session. STOP and toggling off cancel a running workflow mid-step.

## C. Learning capabilities

The pipeline runs: observation (browser text, captions or transcripts; screen OCR as a fallback) → only new lines → quarantine of injected instructions and redaction of secrets → verbatim extraction (definition sentences, examples, takeaways, captions, questions as UNCERTAIN, one labelled INFERENCE per lesson) → attributed memory rows (course, lesson, number, URL, time, session) → recall, course summary and comparison, from stored rows only.

The mandatory scored test (`tests/computer.course.test.ts`) uses a real browser on a 3-lesson course. It restarts the app, then recalls, compares and scores the results:

| Metric | Linux | Windows (CI) | macOS (CI) |
|---|---|---|---|
| Fact extraction | 100% (15/15) | 100% | 100% |
| Definitions | 100% (9/9) | 100% | 100% |
| Retrieval after restart | 100% (8/8) | 100% | 100% |
| Attribution | 100% | 100% | 100% |
| Unsupported (invented) facts | **0** | 0 | 0 |
| Answers about absent topics | **0** | 0 | 0 |
| Injected text stored | **0** | 0 | 0 |
| Persistence across restart | 100% | 100% | 100% |

Gaps were reported correctly: the lesson-3 video has no captions, and lesson 2 contains an injection line. A mutation check showed the test can fail: injecting one invented fact made it fail.

## D. Test results and how to reproduce them

| Suite | Command | Result |
|---|---|---|
| Full regression suite (before the brain switch) | `npm test` | **158 tests: 157 pass, 0 fail, 1 skipped** (CalDAV needs Radicale). Baseline before this work: 130 tests, 129 pass, 1 skipped. |
| Safety / unit | `node --test tests/computer.safety.test.ts` | 13/13 |
| Real browser | `node --test tests/computer.browser.test.ts` | 8/8 |
| Scored course test | `node --test tests/computer.course.test.ts` | pass (scores above) |
| Real X11 OS control | `node --test tests/computer.os.test.ts` | 7/7 on Xvfb + openbox + headed Chromium |
| UI end-to-end | `node tests/e2e/computer.e2e.ts` | toggle → confirmation → *Allow once* → STOP: pass |
| Local brain | `JARVIS_TEST_OPENJARVIS=http://127.0.0.1:8000 node --test tests/openjarvis.test.ts` | 7/7, including the **real** OpenJarvis test |
| Per-OS capability matrix | `npm run computer:platform-test` | see E |
| CI | `.github/workflows/computer-access.yml`, `ci.yml`, `local-brain.yml` | Computer Access and CI **green on ubuntu, windows and macos** |

The real local-brain run used OpenJarvis pinned to commit `427c2dd`, with llama.cpp serving Qwen3-1.7B on 4 CPU cores:

| Step | Result | Time |
|---|---|---|
| Tool call | The model called Jarvis's tool and answered 391 | 3.3 s |
| Kokoro `bm_george` | 247 KB WAV | 4.6 s, including the first load |
| Whisper `base` | Transcribed that speech correctly except "Geekom" → "Geekam" | 1.3 s |
| Jarvis | Stored the memory | — |

## E. Platform compatibility (real runs)

| Capability | Linux (X11) | Windows | macOS |
|---|---|---|---|
| Screen capture | PASS | PASS | PASS |
| OCR | PASS | PASS | PASS |
| Accessibility / window detection | PASS (top-level windows; web element tree through the browser) | PASS | PARTIAL (app level; window titles need the Accessibility permission) |
| Active window | PASS | PASS | PARTIAL (front app only, same reason) |
| Mouse control | PASS | PASS | PASS |
| Keyboard control | PASS | PASS | PASS |
| OS-level click (OCR → click → page changed) | PASS | PASS | PASS |
| Scroll | PASS | PASS | PASS |
| Window switching | PASS | PASS | PASS |
| Browser interaction | PASS | PASS | PASS |
| Learning pipeline | PASS | PASS | PASS |
| Emergency stop | PASS | PASS | PASS |

Linux was run here on Xvfb and in CI. Windows and macOS are **GitHub-hosted runners** (Windows Server and macOS arm64 desktop sessions), not your own PC. The macOS runner had the permissions it needed for input. On a personal Mac you must grant Screen Recording and Accessibility yourself.

## F. Known limitations

- **Native widget accessibility trees** (AT-SPI, UIA, AX) are not wired. Web pages expose their full element tree through the browser. Other apps are understood through OCR text, so icon-only controls are not found.
- **Wayland** blocks synthetic input. Use an X11 session or the browser path.
- **Windows:** elevated windows, UAC and the lock screen can't be driven. SendKeys can't press the Windows key.
- **Learning** keeps only sentences with a recognisable shape. Videos without captions aren't learned, and that is reported. There is no DRM or paywall bypass.
- **Local brain:** the speeds in the A6 profiles are estimates until measured on the A6. Vulkan on the 680M is experimental and untested. OpenJarvis's voice endpoint is newer than its PyPI 1.0.4 release, so the setup pins a GitHub commit. The model I tested here (1.7B) is far smaller than the A6's brain: answer quality there will be much better, and that has not been measured.

## G. Remaining work, in priority order

1. Run the Windows setup on the actual GEEKOM A6 and measure tokens per second for `qwen3.5:9b` and `qwen3:30b-a3b`. Then decide whether the 32 GB default should move to the MoE model.
2. Native accessibility trees (UI Automation on Windows first), for apps without readable text.
3. Test Vulkan on the 680M; it may speed up prompt processing.
4. Feed observations and learning sessions to the **Neo** sub-agent.
5. Vision-model screen understanding: Qwen3.5/3.6 have vision, so a screenshot could go to the local brain when OCR isn't enough.

## H. Demonstration (reproducible)

1. **Observe and interact on a real app:** `node --test tests/computer.os.test.ts` on Linux. It starts X11 and Chromium, then Jarvis reads the screen, finds "Say Hello" by OCR, clicks it with the real mouse, types with the real keyboard and verifies each step.
2. **Learn, save and recall after a restart:** `node --test tests/computer.course.test.ts`. This writes `test-results/computer-learning-score.json`.
3. **The whole stack on your PC:** run the local setup, open http://127.0.0.1:7777, turn on Computer Access (Interact), open a course in the Jarvis browser profile and say *"Hey Jarvis, watch this course and learn from it."* Later, ask *"What did you learn from the course?"*
