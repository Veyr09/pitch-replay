/**
 * The renderer: pitch, 22 players, ball, a camera that follows play, the clock
 * and score, a key-moment overlay, and the strip along the bottom showing the
 * whole pitch with the ball on it.
 *
 * The camera never cuts. It eases toward the ball, and a key moment zooms in and
 * back out again, so the scene always pans rather than jumping.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MatchLog, PITCH_LENGTH_M, PITCH_WIDTH_M } from "./log";
import { MatchClockState, MatchState } from "./state";

export interface ViewerOptions {
  /** Match seconds per wall-clock second. 90 minutes at 60x is a 90-second replay. */
  speed?: number;
}

const GRASS_DARK = 0x1d7a3c;
const GRASS_LIGHT = 0x22894a;
const LINE = 0xf2f7f3;
const HOME = 0xe8402a;
const AWAY = 0x2f5fd0;
const BALL = 0xfdfdfd;
const HUD_INK = 0xffffff;
const HUD_PANEL = 0x11161c;

const MOWN_STRIPES = 12;
const PLAYER_RADIUS_PX = 13;
const BALL_RADIUS_PX = 6;

// Camera. Metres of pitch visible across the width of the canvas at rest, and
// when a key moment pulls in. Both are approached with an exponential ease, so
// there is no cut at any point.
const CAMERA_WIDE_M = 72;
const CAMERA_CLOSE_M = 46;
// How far past the touchline and goal line the camera may travel. Without this
// the camera is pinned to the middle of a 105 m pitch by a 72 m view and simply
// cannot follow the ball into either box - it leaves the frame and the replay
// looks broken. Letting a little background show at the ends is what real
// broadcast framing does anyway.
const OVERSCAN_X_M = 34;
const OVERSCAN_Y_M = 14;
// The ball may never be further than this fraction of the half-view from centre.
const CAMERA_LEASH = 0.62;
const CAMERA_EASE_PER_SECOND = 2.4;
const KEY_MOMENT_SECONDS = 3.5;
const OVERLAY_FADE_SECONDS = 2.6;

const KEY_MOMENTS = new Set(["goal", "card", "save", "offside"]);
const HUD_HEIGHT_PX = 54;
const MINIMAP_HEIGHT_PX = 44;
const MINIMAP_MARGIN_PX = 10;
const MINIMAP_BAND_PX = MINIMAP_HEIGHT_PX + MINIMAP_MARGIN_PX * 2;

const DEFAULT_SPEED = 60;

function expEase(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export class MatchViewer {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly pitch = new Graphics();
  private readonly actors = new Graphics();
  private readonly hud = new Container();
  private readonly hudPanel = new Graphics();
  private readonly minimap = new Graphics();
  private readonly shirtLayer = new Container();
  private readonly shirts: Text[] = [];
  private clockText!: Text;
  private scoreText!: Text;
  private overlayText!: Text;

  private state: MatchClockState | null = null;
  private log: MatchLog | null = null;
  private time = 0;
  private playing = false;
  private speed = DEFAULT_SPEED;
  private cameraX = 0;
  private cameraY = 0;
  private cameraWidthM = CAMERA_WIDE_M;

  async mount(container: HTMLElement, options: ViewerOptions = {}): Promise<void> {
    this.speed = options.speed ?? DEFAULT_SPEED;
    await this.app.init({
      background: 0x0b0f13,
      resizeTo: container,
      antialias: true,
      // A replay engine is judged on smoothness, so resolution follows the
      // device rather than being pinned to 1.
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);

    this.world.addChild(this.pitch, this.actors);
    const shirtStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: "Consolas, Menlo, monospace",
      fontSize: 13,
      fontWeight: "bold",
    });
    for (let i = 0; i < 22; i += 1) {
      const label = new Text({ text: "", style: shirtStyle });
      label.anchor.set(0.5);
      this.shirts.push(label);
      this.shirtLayer.addChild(label);
    }
    this.app.stage.addChild(this.world, this.shirtLayer, this.hud);

    const hudStyle = new TextStyle({
      fill: HUD_INK,
      fontFamily: "Consolas, Menlo, monospace",
      fontSize: 22,
      fontWeight: "bold",
    });
    this.clockText = new Text({ text: "00:00", style: hudStyle });
    this.scoreText = new Text({ text: "HOME 0 - 0 AWAY", style: hudStyle });
    this.overlayText = new Text({
      text: "",
      style: new TextStyle({
        fill: HUD_INK,
        fontFamily: "Consolas, Menlo, monospace",
        fontSize: 46,
        fontWeight: "bold",
      }),
    });
    this.hud.addChild(this.hudPanel, this.clockText, this.scoreText, this.minimap, this.overlayText);

    this.app.ticker.add((ticker) => this.frame(ticker.deltaMS / 1000));
  }

  load(log: MatchLog): void {
    this.log = log;
    this.state = new MatchClockState(log);
    this.time = 0;
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraWidthM = CAMERA_WIDE_M;
    this.drawPitch();
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): boolean {
    this.playing = !this.playing;
    return this.playing;
  }

  setSpeed(multiplier: number): void {
    this.speed = multiplier;
  }

  /** Jump anywhere. Exact, because the state is a pure function of the clock. */
  seek(seconds: number): void {
    if (!this.log) return;
    this.time = Math.max(0, Math.min(this.log.durationSeconds, seconds));
  }

  get currentTime(): number {
    return this.time;
  }

  get duration(): number {
    return this.log?.durationSeconds ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Camera centre and half-width in metres. Used by the in-frame check. */
  get cameraDebug(): { x: number; y: number; halfWidthM: number } {
    return { x: this.cameraX, y: this.cameraY, halfWidthM: this.cameraWidthM / 2 };
  }

  /** Where the ball is right now, so the same check can compare the two. */
  get ballDebug(): { x: number; y: number } | null {
    return this.state ? this.state.at(this.time).ball : null;
  }

  private metresToPixels(): number {
    return this.app.screen.width / this.cameraWidthM;
  }

  private drawPitch(): void {
    const g = this.pitch;
    g.clear();

    const stripeWidth = PITCH_LENGTH_M / MOWN_STRIPES;
    for (let i = 0; i < MOWN_STRIPES; i += 1) {
      g.rect(-PITCH_LENGTH_M / 2 + i * stripeWidth, -PITCH_WIDTH_M / 2, stripeWidth, PITCH_WIDTH_M);
      g.fill(i % 2 === 0 ? GRASS_DARK : GRASS_LIGHT);
    }

    const line = { width: 0.25, color: LINE, alpha: 0.85 };
    g.rect(-PITCH_LENGTH_M / 2, -PITCH_WIDTH_M / 2, PITCH_LENGTH_M, PITCH_WIDTH_M).stroke(line);
    g.moveTo(0, -PITCH_WIDTH_M / 2).lineTo(0, PITCH_WIDTH_M / 2).stroke(line);
    g.circle(0, 0, 9.15).stroke(line);
    g.circle(0, 0, 0.4).fill(LINE);

    for (const side of [-1, 1]) {
      const x = (side * PITCH_LENGTH_M) / 2;
      g.rect(x - side * 16.5, -20.16, side * 16.5, 40.32).stroke(line);
      g.rect(x - side * 5.5, -9.16, side * 5.5, 18.32).stroke(line);
      g.circle(x - side * 11, 0, 0.4).fill(LINE);
      g.rect(x, -3.66, side * 1.8, 7.32).stroke({ width: 0.3, color: LINE, alpha: 1 });
    }
  }

  private frame(dt: number): void {
    if (!this.state || !this.log) return;
    if (this.playing) {
      this.time = Math.min(this.log.durationSeconds, this.time + dt * this.speed);
      if (this.time >= this.log.durationSeconds) this.playing = false;
    }
    const snapshot = this.state.at(this.time);
    this.updateCamera(snapshot, dt);
    this.drawActors(snapshot);
    this.drawHud(snapshot);
  }

  private updateCamera(state: MatchState, dt: number): void {
    const isKeyMoment =
      KEY_MOMENTS.has(state.current.kind) && state.sinceEvent < KEY_MOMENT_SECONDS;
    const targetWidth = isKeyMoment ? CAMERA_CLOSE_M : CAMERA_WIDE_M;
    this.cameraWidthM = expEase(this.cameraWidthM, targetWidth, CAMERA_EASE_PER_SECOND, dt);

    const scale = this.metresToPixels();
    const halfViewX = this.app.screen.width / 2 / scale;
    const halfViewY = (this.app.screen.height - HUD_HEIGHT_PX - MINIMAP_BAND_PX) / 2 / scale;

    // Keep the camera near the pitch so the eye is not left staring at empty
    // background, but allow enough overscan to reach both boxes.
    const limitX = Math.max(0, PITCH_LENGTH_M / 2 - halfViewX + OVERSCAN_X_M);
    const limitY = Math.max(0, PITCH_WIDTH_M / 2 - halfViewY + OVERSCAN_Y_M);
    const targetX = Math.max(-limitX, Math.min(limitX, state.ball.x));
    const targetY = Math.max(-limitY, Math.min(limitY, state.ball.y));

    this.cameraX = expEase(this.cameraX, targetX, CAMERA_EASE_PER_SECOND, dt);
    this.cameraY = expEase(this.cameraY, targetY, CAMERA_EASE_PER_SECOND, dt);

    // The ease alone is not enough, and measuring said so: playing at 200x, the
    // ball outran the camera and was off screen in 26% of frames. The ease is in
    // wall-clock time, so the faster the replay the further the ball gets. A soft
    // follow with a hard leash fixes it without making the motion snappy: pan
    // smoothly, but never let the ball get further than this fraction of the
    // half-view from the centre. Framing then behaves the same at every speed.
    const leashX = halfViewX * CAMERA_LEASH;
    const leashY = halfViewY * CAMERA_LEASH;
    this.cameraX = Math.max(state.ball.x - leashX, Math.min(state.ball.x + leashX, this.cameraX));
    this.cameraY = Math.max(state.ball.y - leashY, Math.min(state.ball.y + leashY, this.cameraY));

    this.world.scale.set(scale);
    this.world.position.set(
      this.app.screen.width / 2 - this.cameraX * scale,
      HUD_HEIGHT_PX
        + (this.app.screen.height - HUD_HEIGHT_PX - MINIMAP_BAND_PX) / 2
        - this.cameraY * scale,
    );
  }

  private drawActors(state: MatchState): void {
    const g = this.actors;
    const scale = this.metresToPixels();
    const radius = PLAYER_RADIUS_PX / scale;
    g.clear();

    for (const player of state.players) {
      g.circle(player.position.x, player.position.y + radius * 0.35, radius * 0.9);
      g.fill({ color: 0x000000, alpha: 0.28 });
    }

    for (const player of state.players) {
      g.circle(player.position.x, player.position.y, radius);
      g.fill(player.team === 0 ? HOME : AWAY);
      g.stroke({ width: radius * 0.14, color: 0x0d1117, alpha: 0.9 });
      if (player.hasBall) {
        g.circle(player.position.x, player.position.y, radius * 1.5);
        g.stroke({ width: radius * 0.16, color: 0xffe27a, alpha: 0.95 });
      }
    }

    g.circle(state.ball.x, state.ball.y, BALL_RADIUS_PX / scale);
    g.fill(BALL);
    g.stroke({ width: BALL_RADIUS_PX / scale / 3, color: 0x0d1117, alpha: 0.8 });

    // Shirt numbers live in screen space, so they stay legible whatever the
    // camera is doing rather than scaling with the world.
    state.players.forEach((player, index) => {
      const label = this.shirts[index];
      if (!label) return;
      label.text = String(player.shirt);
      const point = this.world.toGlobal({ x: player.position.x, y: player.position.y });
      label.position.set(point.x, point.y);
    });
  }

  private drawHud(state: MatchState): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;

    this.hudPanel.clear();
    this.hudPanel.rect(0, 0, width, HUD_HEIGHT_PX).fill(HUD_PANEL);

    this.clockText.text = formatClock(state.clockSeconds);
    this.clockText.position.set(18, HUD_HEIGHT_PX / 2 - this.clockText.height / 2);

    const home = this.log?.homeName ?? "HOME";
    const away = this.log?.awayName ?? "AWAY";
    this.scoreText.text = `${home} ${state.score[0]} - ${state.score[1]} ${away}`;
    this.scoreText.position.set(
      width / 2 - this.scoreText.width / 2,
      HUD_HEIGHT_PX / 2 - this.scoreText.height / 2,
    );

    this.drawMinimap(state, width, height);
    this.drawOverlay(state, width, height);
  }

  private drawMinimap(state: MatchState, width: number, height: number): void {
    const g = this.minimap;
    const mapWidth = Math.min(width - MINIMAP_MARGIN_PX * 2, 520);
    const left = width / 2 - mapWidth / 2;
    const top = height - MINIMAP_HEIGHT_PX - MINIMAP_MARGIN_PX;

    g.clear();
    // The band is opaque so the pitch stops at it rather than running under it.
    g.rect(0, height - MINIMAP_BAND_PX, width, MINIMAP_BAND_PX).fill(0x0b0f13);
    g.roundRect(left, top, mapWidth, MINIMAP_HEIGHT_PX, 6).fill({ color: HUD_PANEL, alpha: 0.85 });
    g.roundRect(left + 4, top + 4, mapWidth - 8, MINIMAP_HEIGHT_PX - 8, 4).fill({
      color: GRASS_DARK,
      alpha: 0.9,
    });

    const innerWidth = mapWidth - 8;
    const innerHeight = MINIMAP_HEIGHT_PX - 8;
    const toMapX = (x: number) => left + 4 + ((x + PITCH_LENGTH_M / 2) / PITCH_LENGTH_M) * innerWidth;
    const toMapY = (y: number) => top + 4 + ((y + PITCH_WIDTH_M / 2) / PITCH_WIDTH_M) * innerHeight;

    g.moveTo(toMapX(0), top + 4).lineTo(toMapX(0), top + 4 + innerHeight);
    g.stroke({ width: 1, color: LINE, alpha: 0.5 });

    for (const player of state.players) {
      g.circle(toMapX(player.position.x), toMapY(player.position.y), 2.4);
      g.fill({ color: player.team === 0 ? HOME : AWAY, alpha: 0.95 });
    }
    g.circle(toMapX(state.ball.x), toMapY(state.ball.y), 3.2);
    g.fill(BALL);

    // Progress along the bottom edge, so the whole match is visible at a glance.
    const progress = this.duration ? state.clockSeconds / this.duration : 0;
    g.rect(left, top + MINIMAP_HEIGHT_PX - 3, mapWidth * progress, 3);
    g.fill({ color: 0xffe27a, alpha: 0.9 });
  }

  private drawOverlay(state: MatchState, width: number, height: number): void {
    const kind = state.current.kind;
    if (!KEY_MOMENTS.has(kind) || state.sinceEvent > OVERLAY_FADE_SECONDS) {
      this.overlayText.alpha = 0;
      return;
    }
    // Fade in fast, hold, fade out. Never a cut.
    const u = state.sinceEvent / OVERLAY_FADE_SECONDS;
    this.overlayText.alpha = Math.min(1, Math.min(u * 6, (1 - u) * 3));
    this.overlayText.text = kind.toUpperCase();
    this.overlayText.position.set(
      width / 2 - this.overlayText.width / 2,
      height * 0.28 - this.overlayText.height / 2,
    );
  }
}
