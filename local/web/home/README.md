# Claude Penguin homepage artwork

`igloo-workshop.png` is the original generated illustration for the English
homepage, created November 8, 2026 with the built-in imagegen tool. It is a
decorative illustration, not a screenshot or evidence of agent execution.
The title, copy, links, and buttons are accessible HTML in the English play
template; `home.css` styles the landing sections. The archived login callback
removes those sections before mounting the game. Other locale templates retain
their archived landing pages.

The ordinary page's **Code with puffles** link opens the opt-in engine on
localhost:8081. The engine must already be started using `./local/agent-start`;
the adjacent setup link explains this. On an engine page, the same link retains
that engine's configured origin. **Play the island** uses the current page's
login hash, retaining bridge/agent query parameters when present.

## Generation prompt

```text
Use case: illustration-story
Asset type: wide website homepage hero banner, approximately 16:9 landscape.
Primary request: Create a beautiful original Claude Penguin homepage illustration that feels authentically like the classic 2005–2013 Club Penguin website and hand-drawn game art. Claude Penguin is a local coding playground where penguins visit snowy igloos and colorful puffles help with coding projects.
Scene/backdrop: A sunny snow-covered island with turquoise sea, softly rounded distant mountains, snow-topped pine trees, and a cozy igloo on the right. The igloo is opened in a charming cutaway revealing a warm wooden desk with a laptop. A friendly classic blue penguin and a small fluffy blue puffle work at the laptop, another orange puffle sits nearby on a stack of books. A gently winding snowy path leads from the foreground toward the igloo.
Style/medium: polished classic Club Penguin 2D cartoon promotional illustration, confident dark navy outlines, simple friendly rounded forms, flat saturated colors with restrained cel shading, snowy white highlights. Penguins have the classic oval body, white belly, orange beak and wide orange feet; puffles are small round furry creatures with big eyes and no limbs.
Composition/framing: Wide landscape full-bleed background. Keep the LEFT 48 percent and upper middle predominantly clear luminous blue sky with just a few small soft clouds, deliberately quiet enough for website title text to be added later. Place the igloo and main characters in the RIGHT half and snow landscape along the bottom. Visually engaging, warmly nostalgic, crisp at web-banner size.
Color palette: bright Club Penguin sky blue and cyan, white snow, navy outlines, warm amber igloo interior, a little orange and blue character color.
Constraints: No text, letters, logos, watermark, navigation, buttons, UI, frames, photorealism, 3D rendering, glossy plastic or Disney signature. Create the illustration alone. Laptop screen may show a few simple colored horizontal strokes suggesting code but no readable text.
```
