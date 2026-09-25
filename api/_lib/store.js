// KV-backed state: tournaments, rooms, prize claims, matchmaking queue, presence.
// Key layout (Upstash Redis):
//   tours            ZSET  tourId -> createdAt          (listing order)
//   sched            ZSET  tourId -> startsAt           (registration + scheduled)
//   active           ZSET  tourId -> startedAt          (running tournaments)
//   tour:<id>        JSON  full tournament document
//   room:<id>        JSON  game room (casual or tournament match)
//   claims           HASH  claimId -> JSON claim        (requisites live ONLY here)
//   subs             ZSET  uid -> ts                    (who receives tours-list)
//   q                LIST  JSON {uid, at}               (casual matchmaking)
//   seen:<room>:<uid> "1" PX                            (presence heartbeat)
import { kv, jget, jset } from './kv.js';

// Presence: how long a heartbeat key lives, and how young a room may be before we
// dare to call the opponent disconnected (they need a chance to ping first).
// Overridable so tests do not have to wait in real time.
export const SEEN_PX = Number(process.env.SEEN_PX_MS || 45000);
export const SEEN_STALE_MS = Number(process.env.SEEN_STALE_MS || 20000);
export const ROOM_TTL_SEC = 3 * 24 * 3600;

export const tourKey = (id) => `tour:${id}`;
export const roomKey = (id) => `room:${id}`;
export const seenKey = (room, uid) => `seen:${room}:${uid}`;

export const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
export const newRoomId = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ---------- tournaments ----------
export const loadTour = (id) => jget(tourKey(id));

export async function saveTour(t) {
  await jset(tourKey(t.id), t);
  await kv.zadd('tours', t.createdAt, t.id);
  if (t.status === 'registration' && t.startsAt) await kv.zadd('sched', t.startsAt, t.id);
  else await kv.zrem('sched', t.id);
  if (t.status === 'active') await kv.zadd('active', Date.now(), t.id);
  else await kv.zrem('active', t.id);
}

export async function deleteTour(id) {
  await kv.del(tourKey(id));
  await kv.zrem('tours', id);
  await kv.zrem('sched', id);
  await kv.zrem('active', id);
}

export async function loadAllTours() {
  const ids = await kv.zrangeAll('tours');
  const docs = await kv.mget(ids.map(tourKey));
  return docs.filter(Boolean).map((s) => JSON.parse(s));
}

export const dueTourIds = () => kv.zrangeScore('sched', 0, Date.now());
export const activeTourIds = () => kv.zrangeAll('active');

// ---------- rooms ----------
export const loadRoom = (id) => jget(roomKey(id));
export const saveRoom = (r) => jset(roomKey(r.id), r, ROOM_TTL_SEC * 1000);
export const deleteRoom = (id) => kv.del(roomKey(id));

// ---------- presence ----------
export const markSeen = (room, uid) => kv.set(seenKey(room, uid), '1', SEEN_PX);
export const isSeen = async (room, uid) => !!(await kv.exists(seenKey(room, uid)));

// ---------- matchmaking ----------
export const queuePush = (entry) => kv.rpush('q', JSON.stringify(entry));
export const queuePop = async () => {
  const out = await kv.lpop('q', 1);
  const raw = Array.isArray(out) ? out[0] : out;
  return raw ? JSON.parse(raw) : null;
};

// ---------- claims ----------
export async function allClaims() {
  const vals = await kv.hvals('claims');
  return vals.map((s) => JSON.parse(s));
}
export const saveClaim = (c) => kv.hset('claims', c.id, JSON.stringify(c));
export const deleteClaim = (id) => kv.hdel('claims', id);

// ---------- tours-list subscribers ----------
export const subscribe = (uid) => kv.zadd('subs', Date.now(), String(uid));
export const unsubscribe = (uid) => kv.zrem('subs', String(uid));
export const subscribers = async () => (await kv.zrangeAll('subs')).map(Number);
