# Research before you invent

Every technique in this project already exists in the literature. Ocean spectra, volumetric
clouds, aerial perspective, parallax terrain, viewmodel rendering — these are solved problems
with published, measured solutions. Guessing at them costs more than reading about them.

The evidence is in this repo. `volumetricFog.js` was written from intuition and shipped an
additive near-field in-scatter that crushed whole-scene saturation to 43% of target — the
single largest visual defect in the project. Aerial perspective has a standard formulation
(Bruneton-Neyret precomputed scattering, or the analytic Preetham/Hosek approximation). Either
one would have gotten the near-field right for free, because both make in-scatter a function
of distance that goes to zero at the camera.

## When to research

Stop and research when any of these is true:

- You are about to write a shader for an effect you cannot name a published technique for.
- Your first implementation looks wrong and you do not have a hypothesis for why.
- You are choosing between two approaches and the tradeoff is not obvious.
- A three.js API is not doing what you expect (check the version — r0.185.1 — the API moves).
- You are reaching for a magic constant and do not know what it physically represents.

Do NOT research when the answer is measurable locally. If the question is "is my in-scatter
too strong", the answer is a capture and `metrics.py`, not a web search. Research tells you
what the technique should be; measurement tells you whether yours is.

## How

Spawn a research agent rather than searching inline — it keeps the source dumps out of your
context and returns the conclusion:

    Agent(subagent_type: 'general-purpose', prompt: """
      Research <technique> for a real-time WebGL2/three.js renderer.
      Consult: three.js docs and examples (threejs.org/examples, github.com/mrdoob/three.js),
      GPU Gems / GPU Pro chapters, SIGGRAPH course notes, Inigo Quilez (iquilezles.org),
      Shadertoy implementations, and papers.
      Return: the standard formulation with actual equations, the parameter values shipped
      games use, the failure modes and how to recognise them in an image, and a WebGL2-GLSL3
      sketch. Cite URLs. Say explicitly what you could NOT verify.
    """)

Good sources for this project, roughly in order of usefulness:

- `threejs.org/examples` and the three.js source — authoritative for r0.185.1 API and for
  what the built-in shader chunks actually compute
- `iquilezles.org` — noise, raymarching, SDFs, analytic tricks, all with derivations
- GPU Gems 1-3 (free online), GPU Pro / GPU Zen chapters
- SIGGRAPH course notes, especially "Physically Based Shading in Theory and Practice"
- Real-Time Rendering 4th ed. references
- Shadertoy — read it for technique, never paste it; licensing and quality both vary
- Game engine source and talks: Frostbite, Unreal, Decima, Guerrilla's cloud talk

## What a research agent owes you

An answer you can implement and check. Specifically:

- The **equation**, not a description of the equation.
- **Parameter values with units** and what they physically mean. "Rayleigh scattering
  coefficient ~5.8e-6 /m at 680nm" beats "a small blue-ish value."
- **Failure modes described visually** — "if the phase function is isotropic you lose the
  bright halo around the sun and the sky reads flat" — so you can recognise the bug in a
  capture instead of in the code.
- **Honest gaps.** "I could not find a source for X" is a useful answer. An invented
  citation is worse than no answer, because it will be believed.

Cross-check anything load-bearing against a second source before you build on it.

## Then measure

Research narrows the search; it never closes it. A technique that is correct in the paper can
still be wrong in this scene — wrong units, wrong scale, double-applied. The rule from
KNOWN_ISSUES §8 stands: isolate the term, null it out, re-measure, conclude. Research changes
what you build. Measurement decides whether it stays.

Write what you learned into `reports/<key>.md` with its citations, so the next agent to touch
that file inherits the reading instead of repeating it.
