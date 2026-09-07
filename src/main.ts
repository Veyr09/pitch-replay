/**
 * Mounts the viewer into the page and wires the controls.
 *
 * The public surface is deliberately small — mount, load, play, pause, seek,
 * setSpeed — because the engine is meant to be dropped into somebody else's
 * application rather than to own the page it sits on.
 */

import { generateMatchLog } from "./log";
import { MatchViewer } from "./viewer";

const SPEEDS = [15, 30, 60, 120];
const DEFAULT_SPEED_INDEX = 2;

async function boot(): Promise<void> {
  const stage = document.getElementById("stage");
  if (!stage) throw new Error("no #stage element to mount into");

  const viewer = new MatchViewer();
  await viewer.mount(stage, { speed: SPEEDS[DEFAULT_SPEED_INDEX] });

  const seedInput = document.getElementById("seed") as HTMLInputElement | null;
  const scrub = document.getElementById("scrub") as HTMLInputElement | null;
  const playButton = document.getElementById("play") as HTMLButtonElement | null;
  const speedButton = document.getElementById("speed") as HTMLButtonElement | null;
  const reloadButton = document.getElementById("reload") as HTMLButtonElement | null;

  let speedIndex = DEFAULT_SPEED_INDEX;

  const loadSeed = (seed: number) => {
    viewer.load(generateMatchLog(seed));
    if (scrub) {
      scrub.max = String(Math.floor(viewer.duration));
      scrub.value = "0";
    }
    viewer.play();
    if (playButton) playButton.textContent = "Pause";
  };

  loadSeed(Number(seedInput?.value ?? 20260907) || 20260907);

  playButton?.addEventListener("click", () => {
    playButton.textContent = viewer.toggle() ? "Pause" : "Play";
  });

  speedButton?.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    viewer.setSpeed(SPEEDS[speedIndex]!);
    speedButton.textContent = `${SPEEDS[speedIndex]}x`;
  });

  reloadButton?.addEventListener("click", () => {
    loadSeed(Number(seedInput?.value ?? 0) || 20260907);
  });

  scrub?.addEventListener("input", () => {
    viewer.seek(Number(scrub.value));
  });

  // Exposed so the ball-in-frame check can drive the real engine rather than a
  // copy of it. Harmless in the demo page and invaluable in a headless run.
  (window as unknown as { viewer: MatchViewer }).viewer = viewer;

  // Keep the scrubber in step with playback without fighting the user's drag.
  let dragging = false;
  scrub?.addEventListener("pointerdown", () => {
    dragging = true;
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  setInterval(() => {
    if (scrub && !dragging) scrub.value = String(Math.floor(viewer.currentTime));
  }, 100);
}

boot().catch((error) => {
  document.body.innerHTML = `<pre style="color:#f66;padding:24px">${String(error)}</pre>`;
});
