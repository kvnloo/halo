# The prompt

This is the entire prompt that produced this repository.

```
I want you to build a first-person shooter at the level of Halo: Campaign Evolved. It should be utterly perfect, visually beautiful, with every single thing done at AAA quality—from textures to physics to anything you could think of.

I've added reference.mp4 in the repo root—39 seconds of 4K/60 gameplay from the Silent Cartographer beach. That is the target.

Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't look triple A, it should keep going.

For the visual verification, use ffmpeg to extract frames from reference.mp4 and capture matching frames from your game at the same camera angle and resolution. Then use OpenCV or another tool to actually measure how similar they are—you can't deterministically tell whether two images look the same, so use tools that can: SSIM for structure, color histogram distance for grade, Laplacian variance for sharpness, edge density for geometry, and a perceptual metric like LPIPS. Score each axis separately so you know which one is failing, write the scores to disk each iteration so you can prove the /loop is improving, and have the critic sub-agent use those numbers to know where to look before it gives its verdict.

Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual Halo: Campaign Evolved game. It should literally compare them side by side blind and say which one looks better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.
```
