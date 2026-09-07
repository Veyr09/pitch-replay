/**
 * The match log this viewer reads, and a deterministic generator for one.
 *
 * The shape here is the hard part of the whole problem, so it is stated first:
 * a match log is a list of EVENTS with one pitch position each, not a stream of
 * per-frame positions. Between two events the viewer has to invent every frame,
 * and it has to invent the same frames every time it runs.
 */

/** Pitch coordinates in metres, origin at the centre spot. */
export interface Point {
  x: number;
  y: number;
}

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;

export type EventKind =
  | "kickoff"
  | "pass"
  | "carry"
  | "shot"
  | "save"
  | "goal"
  | "tackle"
  | "card"
  | "offside"
  | "throwin"
  | "fulltime";

export interface MatchEvent {
  /** Match time in seconds from kickoff. */
  t: number;
  kind: EventKind;
  /** 0 = home, 1 = away. */
  team: 0 | 1;
  /** Shirt number of the player on the ball. */
  player: number;
  /** Where the ball is at this event. */
  at: Point;
  /** Where the ball ends up, for a pass, carry or shot. */
  to?: Point;
}

export interface MatchLog {
  /** Seeded so the same log always produces the same replay. */
  seed: number;
  homeName: string;
  awayName: string;
  /** Ninety minutes of match time in seconds. */
  durationSeconds: number;
  events: MatchEvent[];
}

/**
 * Mulberry32. Small, fast, and — the point here — deterministic: the viewer
 * seeds it from the log, so two runs of the same log are frame-identical.
 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HALF_LENGTH = PITCH_LENGTH_M / 2;
const HALF_WIDTH = PITCH_WIDTH_M / 2;
const FULL_MATCH_SECONDS = 90 * 60;
const MEAN_SECONDS_BETWEEN_EVENTS = 7;

function clampToPitch(p: Point): Point {
  return {
    x: Math.max(-HALF_LENGTH, Math.min(HALF_LENGTH, p.x)),
    y: Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, p.y)),
  };
}

/**
 * Build a synthetic but plausibly shaped log: possession moves up and down the
 * pitch, changes hands on tackles, and occasionally ends in a shot.
 *
 * This exists so the viewer can be demonstrated without a simulation attached.
 * Real content comes from the client's simulation; only the shape matters here.
 */
export function generateMatchLog(seed = 20260907): MatchLog {
  const random = makeRandom(seed);
  const events: MatchEvent[] = [];

  let t = 0;
  let team: 0 | 1 = 0;
  let ball: Point = { x: 0, y: 0 };
  const score: [number, number] = [0, 0];

  events.push({ t: 0, kind: "kickoff", team, player: 10, at: { ...ball } });

  while (t < FULL_MATCH_SECONDS) {
    t += 2 + random() * (MEAN_SECONDS_BETWEEN_EVENTS * 2 - 2);
    if (t >= FULL_MATCH_SECONDS) break;

    // Attacking direction: home goes +x, away goes -x.
    const forward = team === 0 ? 1 : -1;
    const roll = random();
    const player = 2 + Math.floor(random() * 10);

    if (roll < 0.55) {
      const to = clampToPitch({
        x: ball.x + forward * (4 + random() * 22),
        y: ball.y + (random() - 0.5) * 26,
      });
      events.push({ t, kind: "pass", team, player, at: { ...ball }, to });
      ball = to;
    } else if (roll < 0.75) {
      const to = clampToPitch({
        x: ball.x + forward * (3 + random() * 12),
        y: ball.y + (random() - 0.5) * 8,
      });
      events.push({ t, kind: "carry", team, player, at: { ...ball }, to });
      ball = to;
    // Signed, not absolute. With Math.abs a team could "shoot" from deep inside
    // its OWN half at the far goal - one such event sent the ball 105 m in 1.2 s,
    // which is 87 m/s and the only implausible motion left in the replay.
    } else if (roll < 0.86 && ball.x * forward > HALF_LENGTH * 0.45) {
      const goal = { x: forward * HALF_LENGTH, y: (random() - 0.5) * 6 };
      events.push({ t, kind: "shot", team, player, at: { ...ball }, to: goal });
      if (random() < 0.14) {
        score[team] += 1;
        events.push({ t: t + 1.2, kind: "goal", team, player, at: goal });
        ball = { x: 0, y: 0 };
        team = team === 0 ? 1 : 0;
        t += 25;
        events.push({ t, kind: "kickoff", team, player: 10, at: { ...ball } });
      } else {
        events.push({ t: t + 1.2, kind: "save", team: team === 0 ? 1 : 0, player: 1, at: goal });
        ball = { x: forward * (HALF_LENGTH - 12), y: (random() - 0.5) * 20 };
        team = team === 0 ? 1 : 0;
      }
    } else if (roll < 0.94) {
      events.push({ t, kind: "tackle", team: team === 0 ? 1 : 0, player, at: { ...ball } });
      team = team === 0 ? 1 : 0;
    } else if (roll < 0.965) {
      events.push({ t, kind: "offside", team, player, at: { ...ball } });
      team = team === 0 ? 1 : 0;
    } else if (roll < 0.98) {
      events.push({ t, kind: "card", team, player, at: { ...ball } });
    } else {
      const to = clampToPitch({ x: ball.x, y: ball.y > 0 ? HALF_WIDTH : -HALF_WIDTH });
      events.push({ t, kind: "throwin", team, player, at: { ...ball }, to });
      ball = to;
    }
  }

  events.push({ t: FULL_MATCH_SECONDS, kind: "fulltime", team: 0, player: 0, at: { ...ball } });
  events.sort((a, b) => a.t - b.t);
  return {
    seed,
    homeName: "HOME",
    awayName: "AWAY",
    durationSeconds: FULL_MATCH_SECONDS,
    events,
  };
}
