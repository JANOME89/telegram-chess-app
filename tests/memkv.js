// In-memory stand-in for Upstash Redis, implementing exactly the command surface
// api/_lib/kv.js uses. Lets the whole backend be tested without an account.
// Install with: useKvBackend(createMemKv())

const now = () => Date.now();

function entry(store, key, type, make) {
  let e = store.get(key);
  if (e && e.exp && now() > e.exp) { store.delete(key); e = undefined; }
  if (e && e.t !== type) throw new Error(`WRONGTYPE on ${key}`);
  if (!e) { e = make(); e.t = type; store.set(key, e); }
  return e;
}

export function createMemKv() {
  const store = new Map();
  const str = (k) => entry(store, k, 's', () => ({ v: null }));
  const lst = (k) => entry(store, k, 'l', () => ({ a: [] }));
  const hsh = (k) => entry(store, k, 'h', () => ({ m: new Map() }));
  const zst = (k) => entry(store, k, 'z', () => ({ m: new Map() }));

  const getStr = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.exp && now() > e.exp) { store.delete(k); return null; }
    return e.t === 's' ? e.v : null;
  };

  return async function run(cmds) {
    return cmds.map(([op, ...args]) => {
      const key = args[0];
      switch (op) {
        case 'GET': return getStr(key);
        case 'SET': {
          const e = str(key);
          const nx = args.includes('NX');
          const had = e.v !== null && !(e.exp && now() > e.exp);
          if (nx && had) return null;
          e.v = String(args[1]);
          const px = args.indexOf('PX');
          e.exp = px >= 0 ? now() + Number(args[px + 1]) : 0;
          return 'OK';
        }
        case 'DEL': {
          let n = 0;
          for (const k of args) if (store.delete(k)) n++;
          return n;
        }
        case 'EXISTS': return getStr(key) !== null || store.has(key) ? 1 : 0;
        case 'EXPIRE': { const e = store.get(key); if (!e) return 0; e.exp = now() + Number(args[1]) * 1000; return 1; }
        case 'INCR': { const e = str(key); e.v = String(Number(e.v || 0) + 1); return Number(e.v); }

        case 'ZADD': {
          const e = zst(key);
          let added = 0;
          for (let i = 1; i < args.length; i += 2) {
            if (!e.m.has(String(args[i + 1]))) added++;
            e.m.set(String(args[i + 1]), Number(args[i]));
          }
          return added;
        }
        case 'ZREM': return zst(key).m.delete(String(args[1])) ? 1 : 0;
        case 'ZRANGEBYSCORE': {
          const lo = args[1] === '-inf' ? -Infinity : Number(args[1]);
          const hi = args[2] === '+inf' ? Infinity : Number(args[2]);
          return [...zst(key).m].filter(([, s]) => s >= lo && s <= hi)
            .sort((a, b) => a[1] - b[1]).map(([m]) => m);
        }
        case 'ZREVRANGE':
          return [...zst(key).m].sort((a, b) => b[1] - a[1]).map(([m]) => m);

        case 'HSET': {
          const e = hsh(key);
          let added = 0;
          for (let i = 1; i < args.length; i += 2) {
            if (!e.m.has(String(args[i]))) added++;
            e.m.set(String(args[i]), String(args[i + 1]));
          }
          return added;
        }
        case 'HGET': return hsh(key).m.get(String(args[1])) ?? null;
        case 'HDEL': return hsh(key).m.delete(String(args[1])) ? 1 : 0;
        case 'HVALS': return [...hsh(key).m.values()];

        case 'RPUSH': { const e = lst(key); for (const v of args.slice(1)) e.a.push(String(v)); return e.a.length; }
        case 'LPOP': {
          const e = lst(key);
          const n = args[1] === undefined ? 1 : Number(args[1]);
          const out = e.a.splice(0, n);
          return out.length ? out : null;
        }
        case 'LTRIM': {
          const e = lst(key);
          let a = Number(args[1]), b = Number(args[2]);
          if (a < 0) a = Math.max(0, e.a.length + a);
          if (b < 0) b = e.a.length + b;
          e.a = e.a.slice(a, b + 1);
          return 'OK';
        }
        default: throw new Error(`memkv: unsupported command ${op}`);
      }
    });
  };
}
