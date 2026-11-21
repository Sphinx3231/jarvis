# Notices

**Jarvis** — a persistent AI personal operating system, represented by a purple dragon.
Copyright (C) Jarvis contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3 only
(see [LICENSE](LICENSE)). It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE.

If you run a modified Jarvis and let other people use it over a network, you must offer them its
source code (AGPL-3.0 §13). Jarvis shows a link to its source on the Roamies-required screen and in
Settings → About, and serves it at `/api/about`.

Source: https://github.com/Sphinx3231/jarvis

## Built on Roamies

Jarvis is built on **[Roamies](https://github.com/KenKaiii/Roamies)** by KenKaiii (AGPL-3.0-only) and
only runs where Roamies is installed. It uses the same engine, the model picked in Roamies and the
sign-ins saved by Roamies (`~/.gg/sidekick.json`, `~/.gg/auth.json`).

- `server/llm/claudecode.mjs` is copied from Roamies (`showcase/tauri/sidecar/claudecode.mjs`,
  v0.1.38), unmodified apart from a header comment. Copyright (C) KenKaiii, AGPL-3.0-only.

## Third-party components

| Component | How Jarvis uses it | License |
| --- | --- | --- |
| [@kenkaiiii/gg-ai, gg-agent, gg-core](https://github.com/KenKaiii/gg-framework) (the GG framework) | the model engine: providers, streaming, sign-ins and stored credentials | AGPL-3.0-only |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | "Sign in with Claude" in Roamies runs through Claude Code (as in Roamies) | Proprietary: © Anthropic PBC, subject to https://code.claude.com/docs/en/legal-and-compliance (not open source) |
| Claude Code | the binary Roamies downloads at sign-in with Claude; used, never bundled | Anthropic's terms |
| [zod](https://zod.dev) | validation | MIT |
| [React](https://react.dev), [lucide-react](https://lucide.dev) | user interface | MIT, ISC |
| [onnxruntime-web](https://onnxruntime.ai) | runs the built-in memory search model | MIT |
| [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | built-in memory search model, downloaded on first use | Apache-2.0 |
| [imapflow](https://github.com/postalsys/imapflow), [nodemailer](https://nodemailer.com), [mailparser](https://github.com/nodemailer/mailparser) | email | MIT, MIT-0, MIT |
| [tsdav](https://github.com/natelindev/tsdav), [node-ical](https://github.com/jens-maus/node-ical) | calendar | MIT, Apache-2.0 |
| [Electron](https://www.electronjs.org) | desktop app | MIT |
| [GSAP](https://gsap.com) and [@gsap/react](https://github.com/greensock/react) (incl. CustomEase, DrawSVG, ScrambleText, SplitText) | UI motion: entrances, state transitions, agent events | GSAP Standard "no charge" license, https://gsap.com/standard-license (free, not open source) |
| [Lenis](https://github.com/darkroomengineering/lenis) | smooth wheel scrolling inside pages and the chat feed | MIT |
| [React Bits](https://github.com/DavidHDev/react-bits) by David Haz: SplitText, ShinyText, Counter, LatticeLoader, ElectricBorder, SpotlightCard, Noise (adapted copies in `web/src/components/bits/`) | UI components | MIT + Commons Clause (`web/src/components/bits/LICENSE.md`): may be used as part of an application; the components themselves may not be sold or redistributed on their own |

To list every dependency, including indirect ones: `npm ls --all`.
