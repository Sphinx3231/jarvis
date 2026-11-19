# Computer Access Mode

Computer Access Mode lets Jarvis use the computer it runs on roughly the way a person does. It can see the screen, understand windows and pages, move the mouse, type, scroll, switch windows and use the browser where you are already signed in. It can also watch a lesson, learn from it and remember what it learned. **You stay in control:** it is off by default, it has three permission levels, critical actions always wait for you, every action is logged, and STOP is always one click away.

Jarvis is still the assistant that reasons and plans. Computer Access gives the existing agents, task engine and memory a set of capabilities to use. It is not a second agent, and there is no second scheduler or memory store.

---

## 1. Architecture

```
ComputerAccessManager (server/computer/manager.ts)            ← single gate: toggle, level, STOP/abort
├── settings.computerAccess { enabled, level, screenshotRetentionMin, browserEndpoint, watchIntervalSec }
├── OsAdapter            adapters.ts   Linux / Windows / macOS: display detection, processes, windows,
│                                      active window, honest capability report
├── ScreenCapture        capture.ts    scrot/maim/import/grim · screencapture · PowerShell CopyFromScreen
├── OCR                  ocr.ts        system tesseract (+ word boxes, self-verifying probe)
├── ScreenUnderstanding  screen-elements.ts  OCR words → lines → locate “Submit”, layout summary
├── Mouse/Keyboard/Windows input.ts    xdotool (X11) · user32 via PowerShell (Windows) · osascript/cliclick (macOS)
├── Applications/Files   apps.ts       OS launcher (no shell), open file/folder, close (confirmed), running?
├── BrowserController    browser.ts    the user's Chromium-family browser over a loopback DevTools port
├── ActionExecutor       executor.ts   multi-step workflows: observe → act → verify → recover
├── Safety               guard.ts      critical-action classifier, injection quarantine, secret redaction
├── ActivityLog/State    activity.ts   live state machine, persistent action log, confirmations
├── ObservationEngine    watch.ts      “watch this and learn” sessions (browser or screen)
└── LearningPipeline     learning.ts   extraction → attributed FACT/INFERENCE/UNCERTAIN notes in memory
```

Integration with Jarvis:

- **Skills** (`server/computer/skills.ts`, registered with the built-ins): `computer.capabilities`, `computer.telemetry`, `computer.observe`, `computer.find_on_screen`, `computer.browser_read` (observe level); `computer.control`, `computer.click_text`, `computer.browser`, `computer.app`, `computer.workflow` (interact or extended); `computer.watch` (learning sessions); `computer.learn` (one lesson); `computer.recall` (answers only from stored notes). The planner sees these like any other skill. Every call goes through the existing `SkillRunner` and `PermissionEngine`.
- **Permission scopes:** `computer.observe` (ask) and `computer.control` (ask, can never be auto-allowed).
- **Memory:** learned notes are ordinary rows in the existing `memories` table, tagged `learn`, `course:<slug>`, `lesson:<slug>`, kind and status. They are searchable by `memory.search` and by the existing FTS5 and embedding retrieval.
- **Database:** migration 7 adds `computer_actions` (the audit log) and `learning_sessions` (progress, used for resuming).
- **API** (local, authenticated with a token): `GET /api/computer`, `POST /api/computer/stop`, `POST /api/computer/verify`, `POST /api/computer/observe`, `POST /api/computer/control`, `POST /api/computer/click-text`, `POST /api/computer/browser`, `POST /api/computer/browser/start`, `POST /api/computer/workflow`, `GET|POST /api/computer/watch[/start|/stop]`, `POST /api/computer/learn`, `GET /api/computer/learning`, `GET /api/computer/actions`, `POST /api/computer/confirmations/:id`.
- **UI:** a top-bar chip shows OFF, or the live state (Observing / Interacting / Learning / Waiting for approval / …) plus the level, with a STOP button next to it. The chip opens a panel with the current task and app, pending confirmations, the browser connection, learning sessions and recent actions. The toggle, level, browser endpoint and sampling interval are in **Settings → Computer Access**.

Design rules:

- No native Node addons. Everything uses platform-standard tools, so nothing needs an ABI rebuild for Electron and everything works in the forked server process.
- Semantic targets come before coordinates. Jarvis works from page roles and names in the browser and from OCR text elsewhere. It never stores coordinates between actions.
- Text comes before pixels. Screen content reaches the model as OCR text. Raw screenshots are never sent to the model and are deleted immediately by default.

## 2. Supported operating systems

| | Linux | Windows | macOS |
|---|---|---|---|
| Screen capture | scrot / maim / ImageMagick `import` (X11), grim (Wayland) | PowerShell `CopyFromScreen` | `screencapture` (needs Screen Recording permission) |
| OCR | tesseract | tesseract | tesseract |
| Windows / active window | wmctrl + xdotool (X11). Not exposed under Wayland. | `Get-Process` / `GetForegroundWindow` | System Events (osascript) |
| Mouse / keyboard | xdotool (X11). Wayland blocks synthetic input. | user32 `SetCursorPos` / `mouse_event`, SendKeys | cliclick (mouse) + osascript (keys). Needs the Accessibility permission. |
| Window ops (min/max/resize/move/close) | xdotool / wmctrl | user32 `ShowWindow` / `MoveWindow` / `WM_CLOSE` | System Events AX attributes |
| Apps / files | binary / gtk-launch / xdg-open | `Start-Process` / `Invoke-Item` | `open -a` / `open` |
| Browser | Chrome, Chromium, Edge or Brave over DevTools (all OSes) | same | same |

At startup and on **Run capability check**, Jarvis detects the OS, the display server (X11, Wayland, headless, Windows or Quartz), the tools present and whether OCR works. Each capability is reported as `available`, `limited`, `needs-permission`, `unverified` or `unavailable`. A capability only becomes `available` after a live probe has succeeded on that machine. Code that compiles but has not been probed stays `unverified`.

## 3. Dependencies

- **Linux:** `sudo apt install tesseract-ocr scrot xdotool wmctrl` (X11). Optional: `xdg-utils` for opening files. You also need a Chromium-family browser for browser control.
- **Windows:** PowerShell (built in) and Tesseract (`winget install UB-Mannheim.TesseractOCR` or `choco install tesseract`) on PATH. You also need Chrome or Edge.
- **macOS:** `brew install tesseract cliclick`, plus Chrome, Edge, Brave or Chromium.
- You can point Jarvis at a specific browser with `JARVIS_BROWSER=/path/to/chrome`.

## 4. Permissions

**Levels** (Settings → Computer Access):

| Level | Allows |
|---|---|
| Observe | Telemetry, screenshots read as OCR text, the window list and active window, reading browser pages and tabs, captions, watch-and-learn sessions (without scrolling or navigating). |
| Interact | Everything in Observe, plus mouse, keyboard, scroll, window switching and window ops, the browser (click, type, navigate, tabs), on-screen clicks by text, multi-step workflows, and learning sessions that scroll and move to the next lesson. |
| Extended | Everything in Interact, plus opening and closing applications and opening files and folders. |

**Approval boundaries.** These actions are classified from what is being clicked, typed or pressed and where. By default they wait for your explicit confirmation of that exact action, for one use only, and the confirmation expires after 5 minutes. Full Access, allow-policies, grants and "this is part of what you asked for" don't cover them. This is your authorization, not a content rule: Jarvis never refuses these, it asks. You can switch the asking off in **Settings → Computer Access → Ask me before critical actions**; Jarvis then just does them, and every one is still logged. The actions:

- sending or replying to messages, and publishing or posting
- purchases, payments, subscriptions, upgrades and trials
- money transfers
- accepting agreements or contracts and e-signing
- deleting data, emptying the trash, closing accounts
- installing or uninstalling software
- changing passwords, 2FA/MFA, roles or permissions
- running anything with sudo, su, runas or `-Verb RunAs`
- destructive commands (`rm -rf`, `mkfs`, `dd`, `format`, …)
- typing card or account numbers, and sharing items or links externally
- typing a password or other secret into a sign-in field (the value is never read back, logged or shown in the confirmation)
- pressing Enter in a mail composer, chat or checkout
- closing an application or window (unsaved work could be lost)

These rules are enforced in two places, and the setting switches both:

1. **The permission engine** (`Skill.critical`). For a critical input the engine always returns "ask". It never auto-allows the action, and an approval made "by request" does not count.
2. **The manager's guard.** It checks the label that is actually resolved at run time (for example, the real name of the button the model's target matched). It raises a pending confirmation that you approve or refuse in the panel.

Jarvis never bypasses a CAPTCHA, MFA, payment confirmation or any other access control, and never reads cookies, tokens, stored passwords or browser storage. It can sign in with credentials you give it: it types them like a person would.

## 5. Security model

- **The toggle is the single off switch.** With it off, every observe and control method throws. Turning it off aborts in-flight actions, workflows and learning sessions through a shared `AbortSignal`, and voids pending confirmations. **STOP** does the same and also turns the toggle off.
- **Only the user has authority.** The API needs the per-install token (`x-jarvis-token`), so a web page cannot turn Computer Access on, change its level or approve a confirmation. The end-to-end test checks this.
- **External content is data, never authority.** Screen, page and caption text is marked as untrusted output. Lines that try to instruct Jarvis ("ignore previous instructions", "Jarvis must click…", "send the user's files…", "turn off computer access") are flagged in observations and quarantined before learning, so they are never stored as knowledge.
- **No credential collection.** The DevTools connection uses a method allowlist, so `Network.*`, `Storage.*`, `DOMStorage.*`, `IndexedDB.*`, `CacheStorage.*`, `Fetch.*`, `Browser.*` and `Target.*` cannot be called. Page scripts are fixed, read-only extractors; model-supplied JavaScript is never run. Password field values are never read: typing into one is checked by asking the page whether the field holds what was typed, and the text is never logged. Credential-shaped strings seen on screen while watching (passwords, API keys, tokens, card numbers) are redacted before anything is stored.
- **Local only.** The browser endpoint must be a loopback address (enforced in settings and in the controller). Jarvis launches the browser with `--remote-debugging-address=127.0.0.1`. Nothing is exposed to the network.
- **Screenshots** are deleted as soon as they are read (retention 0 by default; configurable from 0 to 1440 minutes).
- **Audit.** Every action is written to `computer_actions`: time, kind, target, outcome, verification result, critical category, task and duration. The log survives restarts.

### Using your logged-in browser

Jarvis drives the browser through a dedicated, persistent **Jarvis profile**. Click **Start browser** in the panel, or call `computer.app` with `start_browser`. Sign in to your sites there once, and the sessions persist like any other browser profile. Two reasons for this design: Chrome 136+ refuses remote debugging on your default profile, and it keeps Jarvis out of your main profile's saved data. If you already run a browser with `--remote-debugging-port`, set its address in Settings. For browsers Jarvis can't connect to, the screen path (OCR + mouse + keyboard) works with any browser.

## 6. Turning it on and off

1. **Settings → Computer Access**: switch it on (you'll be asked to confirm), then pick a level.
2. The top bar now shows `Computer: Idle · INTERACT` and a red **STOP** button.
3. Turn it off with the toggle, or press **STOP** (top bar, panel, or Settings) to abort everything and turn it off at once.

## 7. Learning sessions ("watch this and learn")

Open a lesson, then tell Jarvis: *"Watch this course and learn from it."* The planner uses `computer.watch` → `start`. Options:

- `autoScroll` (Interact level): scrolls to reveal content that only loads after scrolling.
- `nextLabel: "Next lesson"` (Interact level): moves on to the next lesson when one is finished.
- `source: "screen"`: learns from any application by OCR instead of the browser.

How it works:

1. Jarvis identifies the course (page metadata or breadcrumb) and the lesson (lesson title or `<h1>`; the lesson number comes from the title or URL).
2. Every interval (default 4 s) it reads the page text, headings, captions and transcripts. Between full reads it polls the captions every ~350 ms so short caption cues are not missed. Unchanged samples cost nothing.
3. Only **new** lines are processed. Instruction-like lines are quarantined and secrets are redacted.
4. Extraction stores sentences **verbatim**, never paraphrased: definition sentences ("X is …", "X refers to …", "Definition: …"), examples ("For example, …"), takeaways ("Important: …"), captions, and open questions (marked UNCERTAIN). When several terms appear together, one INFERENCE note is added and labelled as derived.
5. Each note is stored as a memory with its course, lesson, number, URL, time, site and session, plus a FACT, INFERENCE or UNCERTAIN status. Duplicates merge.
6. Progress (last lesson and URL) is saved, so *"continue where you left off"* (`computer.watch` → `continue`) goes back to the right page after a restart.
7. Gaps are reported honestly: a video without captions, a sign-in wall, a dialog, a closed tab, low OCR confidence, or content that was never scrolled into view. A course is never reported as fully learned when parts were inaccessible.

To ask about it later, use `computer.recall`: *"What did you learn from the course?"* (course summary), *"Explain lesson 2"* (that lesson's notes), *"Compare lesson 1 and lesson 3"* (both sides plus shared terms). If nothing was stored, it answers "not in what was learned" and does not guess.

Content limits: Jarvis uses only what your session can already access normally (visible text, captions, transcripts, slides). It does not bypass DRM, paywalls or download protection. It stores notes and references, not copies of the course.

## 8. Known limitations

- **Native widget accessibility trees** (AT-SPI, UI Automation, AX) are not wired. Inside web pages, Jarvis gets the full element tree (roles, names, states) from the browser. In other apps it finds controls by their on-screen text (OCR). That works for labelled buttons and menus, but not for icon-only controls.
- **Wayland** blocks synthetic input and hides the window list from other processes. Capture works with grim, but interaction is reported `unavailable`. Use an X11 session, or the browser path.
- **macOS** needs the Screen Recording and Accessibility permissions (System Settings → Privacy & Security), granted to the app that runs Jarvis. Without them, the capabilities are reported as blocked.
- **Windows** cannot drive elevated (admin) windows from a normal process, the secure desktop (UAC prompts), or the lock screen. SendKeys cannot send the Windows key.
- **OCR-only understanding** depends on fonts, contrast and scaling. Glued or low-confidence words are matched as weak matches, and the result of every click is re-verified.
- **Video content** without captions or a transcript cannot be learned. Jarvis reports this instead of guessing.
- **Learning extraction** keeps only sentences with a recognisable shape (definitions, examples, takeaways, captions). Free-form narrative that matches none of those patterns is not stored as notes. Lessons where nothing could be extracted are listed as gaps.

## 9. Tests and how to reproduce them

```bash
npm run test:computer                       # unit + safety + real-browser + scored course test (+ X11 tests on Linux)
node --test tests/computer.os.test.ts       # real X11: needs Xvfb, openbox, scrot, xdotool, wmctrl, tesseract, xterm + a browser
npm run build && node tests/e2e/computer.e2e.ts   # UI: toggle → confirmation → STOP (needs Playwright)
npm run computer:platform-test              # real capability matrix on THIS machine → test-results/platform-<os>.json
```

`.github/workflows/computer-access.yml` runs the suites and the platform test on Ubuntu, Windows and macOS runners, and uploads `test-results/` as evidence.

The local test environment is `tests/fixtures/computer-site.ts`. It has a web app with buttons, a form (text, email, textarea, checkbox, select, password), tabs, a menu, a modal dialog, a slow action, a dead button, a "Send message" button, content below the fold and an injection paragraph. It also has a sign-in page, a slow page, and a 3-lesson course with prose definitions, examples, live captions, lazy-loaded content, "Next lesson" links, a silent video and an injection line. The course's ground truth is exported so the learning test can score Jarvis against it.

Results are recorded in [COMPUTER_ACCESS_REPORT.md](COMPUTER_ACCESS_REPORT.md).
