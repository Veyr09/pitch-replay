/**
 * Turning a sparse event log into a position for every player on every frame.
 *
 * This is the whole problem. The log gives one pitch position per event, every
 * few seconds; the screen needs 22 players and a ball at 60 fps. Everything
 * between two events has to be invented, and it has to be invented the same way
 * every time so that the same log always produces the same replay.
 *
 * Two decisions carry the result:
 *
 * 1. **The ball is not linearly interpolated across the gap.** A pass that takes
 *    0.9 seconds and then waits four seconds for the next event looks nothing
 *    like a ball sliding slowly across the pitch for five seconds. So the ball
 *    travels at a plausible speed with an ease-out, arrives, and dwells. The gap
 *    is absorbed by waiting, not by slowing down.
 *
 * 2. **Off-ball players are a pure function of time, not a simulation.** Every
 *    player's position is computed from the formation, the ball, and the clock —
 *    no integration, no accumulated state. That is what makes seeking exact:
 *    jumping to minute 63 gives the same picture as playing to minute 63, because
 *    it is the same expression evaluated at the same t. Smoothness comes from
 *    averaging the target over a short time window rather than from a spring.
 */

import { MatchEvent, MatchLog, Point, makeRandom } from "./log";

export interface PlayerState {
  team: 0 | 1;
  shirt: number;
  position: Point;
  hasBall: boolean;
}

export interface MatchState {
  clockSeconds: number;
  ball: Point;
  players: PlayerState[];
  score: [number, number];
  /** The most recent event at or before the current time, for overlays. */
  current: MatchEvent;
  /** How long ago that event happened, in seconds. Drives overlay fades. */
  sinceEvent: number;
}

const PLAYERS_PER_TEAM = 11;

/** 4-4-2, as fractions of half-length and half-width, for the home team. */
const FORMATION: ReadonlyArray<Point> = [
  { x: -0.92, y: 0 },
  { x: -0.55, y: -0.55 },
  { x: -0.6, y: -0.2 },
  { x: -0.6, y: 0.2 },
  { x: -0.55, y: 0.55 },
  { x: -0.12, y: -0.6 },
  { x: -0.18, y: -0.2 },
  { x: -0.18, y: 0.2 },
  { x: -0.12, y: 0.6 },
  { x: 0.3, y: -0.22 },
  { x: 0.3, y: 0.22 },
];

const HALF_LENGTH = 105 / 2;
const HALF_WIDTH = 68 / 2;

// A pass covers ground at roughly this speed; a carry at a runner's pace.
const PASS_SPEED_M_PER_S = 18;
const CARRY_SPEED_M_PER_S = 7;
const SHOT_SPEED_M_PER_S = 26;
const MIN_TRAVEL_SECONDS = 0.25;

// The team shape slides up and down the pitch with the ball, but not one for
// one: a back four does not stand on the halfway line because the ball is there.
const SHAPE_FOLLOW = 0.45;
// How far the nearest few players drift off their slot toward the ball.
const BALL_ATTRACTION = 0.55;
const ATTRACTION_RADIUS_M = 28;
// Idle drift, so nobody stands perfectly still while play is elsewhere.
const DRIFT_AMPLITUDE_M = 1.6;

// The smoothing window. Targets are averaged across this many samples spanning
// this many seconds, which turns the step changes at each event into motion.
const SMOOTHING_SECONDS = 2.2;
const SMOOTHING_SAMPLES = 7;

function travelSeconds(kind: MatchEvent["kind"], distance: number): number {
  const speed =
    kind === "shot" ? SHOT_SPEED_M_PER_S : kind === "carry" ? CARRY_SPEED_M_PER_S : PASS_SPEED_M_PER_S;
  return Math.max(MIN_TRAVEL_SECONDS, distance / speed);
}

function easeOut(u: number): number {
  return 1 - (1 - u) * (1 - u);
}

/** Index of the last event at or before t. Binary search: seek must be cheap. */
function eventIndexAt(events: readonly MatchEvent[], t: number): number {
  let low = 0;
  let high = events.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (events[mid]!.t <= t) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Where the ball is at time t: travelling if mid-flight, parked if not. */
function ballAt(events: readonly MatchEvent[], t: number): Point {
  const index = eventIndexAt(events, t);
  const event = events[index]!;
  const from = event.at;
  const to = event.to;
  if (!to) return from;

  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const flight = travelSeconds(event.kind, distance);
  const u = Math.min(1, Math.max(0, (t - event.t) / flight));
  const eased = easeOut(u);
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
}

function scoreAt(events: readonly MatchEvent[], t: number): [number, number] {
  const score: [number, number] = [0, 0];
  for (const event of events) {
    if (event.t > t) break;
    if (event.kind === "goal") score[event.team] += 1;
  }
  return score;
}

/**
 * The instantaneous target for one player, before smoothing. Pure in t.
 */
function targetFor(
  team: 0 | 1,
  slot: number,
  ball: Point,
  t: number,
  phase: number,
): Point {
  const base = FORMATION[slot]!;
  // Away plays the other way round.
  const mirror = team === 0 ? 1 : -1;
  const anchorX = base.x * HALF_LENGTH * mirror;
  const anchorY = base.y * HALF_WIDTH * mirror;

  // The whole shape slides toward the ball's end of the pitch.
  let x = anchorX + ball.x * SHAPE_FOLLOW;
  let y = anchorY + ball.y * SHAPE_FOLLOW * 0.5;

  // Whoever is near the ball closes on it; the keeper never does.
  if (slot > 0) {
    const distance = Math.hypot(ball.x - x, ball.y - y);
    if (distance < ATTRACTION_RADIUS_M) {
      const pull = BALL_ATTRACTION * (1 - distance / ATTRACTION_RADIUS_M);
      x += (ball.x - x) * pull;
      y += (ball.y - y) * pull;
    }
  } else {
    // Keeper tracks the ball laterally and stays near the line.
    x = mirror * -HALF_LENGTH * 0.93;
    y = ball.y * 0.25;
  }

  // Deterministic idle drift, seeded per player.
  x += Math.sin(t * 0.7 + phase) * DRIFT_AMPLITUDE_M;
  y += Math.cos(t * 0.53 + phase * 1.7) * DRIFT_AMPLITUDE_M;

  return {
    x: Math.max(-HALF_LENGTH, Math.min(HALF_LENGTH, x)),
    y: Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, y)),
  };
}

export class MatchClockState {
  private readonly phases: number[];

  constructor(private readonly log: MatchLog) {
    const random = makeRandom(log.seed ^ 0x9e3779b9);
    this.phases = Array.from({ length: PLAYERS_PER_TEAM * 2 }, () => random() * Math.PI * 2);
  }

  /** The full picture at time t. Pure: the same t always gives the same state. */
  at(t: number): MatchState {
    const events = this.log.events;
    const clamped = Math.max(0, Math.min(this.log.durationSeconds, t));
    const index = eventIndexAt(events, clamped);
    const current = events[index]!;
    const ball = ballAt(events, clamped);

    const players: PlayerState[] = [];
    for (let team = 0 as 0 | 1; team < 2; team = (team + 1) as 0 | 1) {
      for (let slot = 0; slot < PLAYERS_PER_TEAM; slot += 1) {
        const phase = this.phases[team * PLAYERS_PER_TEAM + slot]!;
        // Average the target across a short window. This is the smoothing: it
        // keeps the function pure, so seeking stays exact, while removing the
        // jump that each new event would otherwise cause.
        let sumX = 0;
        let sumY = 0;
        for (let s = 0; s < SMOOTHING_SAMPLES; s += 1) {
          const offset = (s / (SMOOTHING_SAMPLES - 1) - 1) * SMOOTHING_SECONDS;
          const sampleT = Math.max(0, clamped + offset);
          const sampleBall = ballAt(events, sampleT);
          const target = targetFor(team, slot, sampleBall, sampleT, phase);
          sumX += target.x;
          sumY += target.y;
        }

        const shirt = slot + 1;
        const onBall = current.team === team && current.player === shirt && !!current.to;
        const position = onBall
          ? { ...ball }
          : { x: sumX / SMOOTHING_SAMPLES, y: sumY / SMOOTHING_SAMPLES };
        players.push({ team, shirt, position, hasBall: onBall });
      }
    }

    return {
      clockSeconds: clamped,
      ball,
      players,
      score: scoreAt(events, clamped),
      current,
      sinceEvent: clamped - current.t,
    };
  }
}
