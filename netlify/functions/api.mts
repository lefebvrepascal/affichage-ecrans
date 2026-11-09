/**
 * Affichage — API (Netlify Functions + Netlify Blobs)
 *
 * Données (store « affichage ») :
 *   db                 → écrans, contenus, playlists, alerte, réglages (JSON)
 *   secret             → sel du jeton administrateur
 *   hb/<deviceId>      → dernier signe de vie d'un écran
 *   pend/<code>        → écran en attente d'appairage
 *   dev/<deviceId>     → code d'appairage attribué à un appareil
 *   meta/<mediaId>     → description d'un média (type, taille, nb de morceaux)
 *   m/<mediaId>/<n>    → morceaux de 3 Mo du fichier média
 */
import { getStore } from "@netlify/blobs";
import { purgeCache, type Config, type Context } from "@netlify/functions";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const CHUNK = 3 * 1024 * 1024;          // taille d'un morceau de média
const MAX_MEDIA = 300 * 1024 * 1024;     // 300 Mo par fichier
const ONLINE_MS = 11 * 60 * 1000;        // écran « en ligne » si signe de vie < 11 min
const PENDING_FRESH_MS = 90 * 1000;      // code visible si l'écran est actif

const store = () => getStore({ name: "affichage", consistency: "strong" });
const uid = () => randomBytes(6).toString("hex");

type Json = Record<string, any>;

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}
const err = (msg: string, status = 400) => json({ error: msg }, status);

/* ---------- validation ---------- */
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, def: number, min = 0, max = 86400) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const color = (v: unknown, def: string) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : def);
const hhmm = (v: unknown, def: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : def);
const isDevice = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(v);
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{12}$/.test(v);

/* ---------- base de données ---------- */
function defaultDb(): Json {
  const clockId = uid(), welcomeId = uid(), plId = uid(), now = Date.now();
  return {
    settings: { schoolName: "" },
    contents: [
      { id: welcomeId, type: "text", name: "Bienvenue", title: "Bienvenue",
        body: "Bonne journée à toutes et à tous !", bg: "#1d3557", fg: "#ffffff", accent: "#f4a261", duration: 12, createdAt: now },
      { id: clockId, type: "clock", name: "Horloge et date", duration: 15, createdAt: now },
    ],
    playlists: [{ id: plId, name: "Accueil", items: [{ contentId: welcomeId, duration: 12 }, { contentId: clockId, duration: 15 }] }],
    screens: [],
    alert: null,
  };
}

async function getDb(): Promise<Json> {
  const s = store();
  let db = (await s.get("db", { type: "json" })) as Json | null;
  if (!db) {
    await s.setJSON("db", defaultDb(), { onlyIfNew: true });
    db = (await s.get("db", { type: "json" })) as Json;
  }
  return db;
}

async function saveDb(db: Json) {
  await store().setJSON("db", db);
  try { await purgeCache({ tags: ["cfg"] }); } catch (e) { console.warn("purge", e); } // à défaut : cache de 30 s
}

/* ---------- authentification : comptes administrateurs nominatifs ----------
 * Blob « users » : [{ id, login, name, salt, hash (scrypt), mustChange, createdAt }]
 * Au premier lancement, la console propose de créer le premier compte (« installation »).
 * Variable d'environnement facultative SETUP_CODE : si elle est définie, ce code est exigé pour l'installation.
 * Jeton de session : "<id>.<empreinte>" ; changer un mot de passe déconnecte les autres sessions du compte. */
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const scrypt = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString("hex");
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const WEAK = ["admin123456", "administrateur", "12345678", "123456789", "motdepasse", "password", "azertyuiop", "affichage"];
const cleanLogin = (v: unknown) => str(v, 40).trim().toLowerCase();

async function getSecret() {
  const s = store();
  let secret = await s.get("secret");
  if (!secret) {
    await s.set("secret", randomBytes(16).toString("hex"), { onlyIfNew: true });
    secret = (await s.get("secret")) as string;
  }
  return secret as string;
}

async function getUsers(): Promise<Json[]> {
  const s = store();
  const data = ((await s.get("users", { type: "json" })) as Json | null) || { list: [] };
  return data.list;
}
async function saveUsers(list: Json[]) {
  const s = store();
  const data = ((await s.get("users", { type: "json" })) as Json | null) || { list: [] };
  data.list = list;
  await s.setJSON("users", data);
}

async function tokenFor(u: Json) {
  return u.id + "." + sha("token:" + u.id + ":" + u.hash + ":" + (await getSecret()));
}
async function currentUser(req: Request, url: URL): Promise<Json | null> {
  const t = req.headers.get("x-admin-token") || url.searchParams.get("token") || "";
  const id = t.split(".")[0];
  if (!id) return null;
  const u = (await getUsers()).find(x => x.id === id);
  return u && t === (await tokenFor(u)) ? u : null;
}
const publicUser = (u: Json) => ({ id: u.id, login: u.login, name: u.name, mustChange: !!u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin || null });

/* ---------- configuration envoyée aux écrans ---------- */
function resolvePlaylist(db: Json, id: string) {
  const pl = db.playlists.find((p: Json) => p.id === id);
  if (!pl) return null;
  const items = pl.items
    .map((it: Json) => ({ duration: it.duration, content: db.contents.find((c: Json) => c.id === it.contentId) }))
    .filter((it: Json) => it.content);
  return { id: pl.id, name: pl.name, items };
}

function configFor(db: Json, scr: Json) {
  const ids = new Set([scr.playlistId, ...(scr.schedules || []).map((r: Json) => r.playlistId)].filter(Boolean));
  const playlists: Json = {};
  for (const id of ids) { const r = resolvePlaylist(db, id as string); if (r) playlists[id as string] = r; }
  return {
    type: "config",
    screen: {
      id: scr.id, name: scr.name, playlistId: scr.playlistId, schedules: scr.schedules || [],
      orientation: scr.orientation || 0, margin: scr.margin || 0, ticker: scr.ticker || "", showClock: scr.showClock !== false, cmd: scr.cmd || null,
    },
    playlists, settings: db.settings, alert: db.alert,
  };
}

/* ---------- contenus ---------- */
function applyContentFields(c: Json, b: Json) {
  if ("name" in b) c.name = str(b.name, 80).trim() || c.name || "Sans titre";
  if ("duration" in b) c.duration = num(b.duration, c.duration ?? 10);
  if (c.type === "text") {
    if ("title" in b) c.title = str(b.title, 200);
    if ("body" in b) c.body = str(b.body, 3000);
    if ("bg" in b) c.bg = color(b.bg, "#1d3557");
    if ("fg" in b) c.fg = color(b.fg, "#ffffff");
    if ("accent" in b) c.accent = color(b.accent, "#f4a261");
  }
  if ((c.type === "web" || c.type === "youtube") && "url" in b) {
    const u = str(b.url, 2000).trim();
    if (!/^https:\/\//i.test(u)) throw new Error("L'adresse doit commencer par https://");
    c.url = u;
  }
  if (c.type === "image" || c.type === "video" || c.type === "slides") {
    if ("fit" in b) c.fit = b.fit === "cover" ? "cover" : "contain";
    if ("muted" in b) c.muted = !!b.muted;
  }
}

async function deleteMedia(id: string) {
  const s = store();
  const { blobs } = await s.list({ prefix: `m/${id}/` });
  await Promise.all(blobs.map(b => s.delete(b.key)));
  await s.delete(`meta/${id}`);
}

/* ================================================================== */
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [r0, r1, r2] = parts;
  const M = req.method;
  const body = async (): Promise<Json> => { try { return await req.json(); } catch { return {}; } };

  try {
    /* ---------------- Écrans (public) ---------------- */
    if (r0 === "hello" && M === "POST") {
      const b = await body();
      if (!isDevice(b.deviceId)) return err("Identifiant d'écran invalide");
      const id = b.deviceId, res = str(b.res, 30), ua = str(b.ua, 200);
      const s = store();
      await s.setJSON(`hb/${id}`, { at: Date.now(), res, ua });
      const db = await getDb();
      if (db.screens.some((x: Json) => x.id === id)) return json({ paired: true });

      let code = (await s.get(`dev/${id}`)) as string | null;
      if (code) {
        const p = (await s.get(`pend/${code}`, { type: "json" })) as Json | null;
        if (!p || p.deviceId !== id) code = null;
      }
      if (!code) {
        for (let i = 0; i < 30 && !code; i++) {
          const c = String(1000 + Math.floor(Math.random() * 9000));
          const entry = { deviceId: id, since: Date.now(), res, ua };
          const w = await s.setJSON(`pend/${c}`, entry, { onlyIfNew: true });
          if (w.modified) { code = c; break; }
          const ex = (await s.get(`pend/${c}`, { type: "json" })) as Json | null;
          if (ex && Date.now() - ex.since > 86400e3) { await s.setJSON(`pend/${c}`, entry); code = c; }
        }
        if (!code) return err("Aucun code disponible, réessayez", 503);
        await s.set(`dev/${id}`, code);
      }
      return json({ paired: false, code });
    }

    if (r0 === "config" && M === "GET" && isDevice(r1)) {
      const db = await getDb();
      const scr = db.screens.find((x: Json) => x.id === r1);
      const cache = { "Netlify-CDN-Cache-Control": "public, durable, s-maxage=30", "Netlify-Cache-Tag": "cfg" };
      return json(scr ? configFor(db, scr) : { type: "unpaired" }, 200, cache);
    }

    if (r0 === "diag" && M === "POST") {
      const b = await body();
      if (!isDevice(b.deviceId)) return err("Identifiant d'écran invalide");
      const entry = { at: Date.now(), msg: str(b.msg, 500), ua: str(b.ua, 300) };
      console.log(`[diag] ${b.deviceId} ${entry.msg} | ${entry.ua}`);
      await store().setJSON(`diag/${b.deviceId}`, entry);
      return json({ ok: true });
    }

    /* ---- installation : création du premier compte ---- */
    if (r0 === "setup" && M === "GET") {
      const needsSetup = (await getUsers()).length === 0;
      return json({ needsSetup, codeRequired: needsSetup && !!Netlify.env.get("SETUP_CODE") });
    }
    if (r0 === "setup" && M === "POST") {
      const b = await body();
      if ((await getUsers()).length) return err("L'application est déjà installée : connectez-vous.", 409);
      const code = Netlify.env.get("SETUP_CODE");
      if (code && str(b.code, 200) !== code) { await new Promise(r => setTimeout(r, 800)); return err("Code d'installation incorrect", 401); }
      const login = cleanLogin(b.login), name = str(b.name, 80).trim(), pw = str(b.password, 200), school = str(b.schoolName, 120).trim();
      if (!school) return err("Indiquez le nom de l'établissement");
      if (!name) return err("Indiquez votre nom");
      if (!/^[a-z0-9._-]{3,40}$/.test(login)) return err("Identifiant : 3 à 40 caractères (lettres sans accent, chiffres, . _ -)");
      if (pw.length < 8) return err("Le mot de passe doit faire au moins 8 caractères");
      if (WEAK.includes(pw.toLowerCase())) return err("Mot de passe trop facile à deviner");
      const salt = randomBytes(16).toString("hex");
      const u = { id: uid(), login, name, salt, hash: scrypt(pw, salt), mustChange: false, createdAt: Date.now(), lastLogin: Date.now() };
      const s0 = store();
      const w = await s0.setJSON("users", { list: [u] }, { onlyIfNew: true });   // une seule installation possible
      if (!w.modified) return err("L'application est déjà installée : connectez-vous.", 409);
      const db = await getDb();
      db.settings.schoolName = school;
      const welcome = db.contents.find((c: Json) => c.type === "text" && c.name === "Bienvenue");
      if (welcome && welcome.title === "Bienvenue") welcome.title = "Bienvenue — " + school;
      await saveDb(db);
      return json({ token: await tokenFor(u), user: publicUser(u) });
    }

    if (r0 === "login" && M === "POST") {
      const b = await body();
      const login = cleanLogin(b.login);
      const pw = str(b.password, 200);
      const users = await getUsers();
      const u = users.find(x => x.login === login) || null;
      if (!u || !sameHex(scrypt(pw, u.salt), u.hash)) {
        await new Promise(r => setTimeout(r, 800));
        return err("Identifiant ou mot de passe incorrect", 401);
      }
      u.lastLogin = Date.now();
      await saveUsers(users);
      return json({ token: await tokenFor(u), mustChange: !!u.mustChange, user: publicUser(u) });
    }

    /* ---------------- Console (authentifiée) ---------------- */
    const me = await currentUser(req, url);
    if (!me) return err("Non autorisé", 401);
    const s = store();

    if (r0 === "state" && M === "GET") {
      const db = await getDb();
      const now = Date.now();
      const screens = await Promise.all(db.screens.map(async (x: Json) => {
        const [hb, dg] = await Promise.all([
          s.get(`hb/${x.id}`, { type: "json" }) as Promise<Json | null>,
          s.get(`diag/${x.id}`, { type: "json" }) as Promise<Json | null>,
        ]);
        const diag = dg && now - dg.at < 2 * 86400e3 && dg.at > (x.diagClearedAt || 0) ? dg : null;
        return { ...x, lastSeen: hb?.at || x.pairedAt, resolution: hb?.res || "", ua: hb?.ua || "", diag,
          online: !!hb && now - hb.at < ONLINE_MS };
      }));
      const { blobs } = await s.list({ prefix: "pend/" });
      const pending: Json[] = [];
      await Promise.all(blobs.map(async b => {
        const p = (await s.get(b.key, { type: "json" })) as Json | null;
        if (!p) return;
        if (now - p.since > 86400e3) { await s.delete(b.key); return; }
        if (db.screens.some((x: Json) => x.id === p.deviceId)) return;
        const hb = (await s.get(`hb/${p.deviceId}`, { type: "json" })) as Json | null;
        if (hb && now - hb.at < PENDING_FRESH_MS) pending.push({ code: b.key.slice(5), since: p.since, ua: p.ua, res: p.res });
      }));
      const users = await getUsers();
      return json({ settings: db.settings, contents: db.contents, playlists: db.playlists, alert: db.alert, screens, pending,
        me: publicUser(me), users: users.map(publicUser) });
    }

    /* ---- écrans ---- */
    if (r0 === "screens") {
      const db = await getDb();
      if (r1 === "pair" && M === "POST") {
        const b = await body();
        const code = str(b.code, 10).trim();
        const p = /^\d{4}$/.test(code) ? ((await s.get(`pend/${code}`, { type: "json" })) as Json | null) : null;
        if (!p) return err("Code inconnu : vérifiez le code affiché sur l'écran.", 404);
        const scr = {
          id: p.deviceId,
          name: str(b.name, 80).trim() || "Écran " + (db.screens.length + 1),
          location: str(b.location, 120).trim(),
          playlistId: db.playlists[0]?.id || null,
          schedules: [], orientation: 0, ticker: "", showClock: true, pairedAt: Date.now(), cmd: null,
        };
        db.screens = db.screens.filter((x: Json) => x.id !== scr.id);
        db.screens.push(scr);
        await saveDb(db);
        await Promise.all([s.delete(`pend/${code}`), s.delete(`dev/${p.deviceId}`)]);
        return json(scr);
      }
      if (r2 === "cmd" && M === "POST") {
        const b = await body();
        const cmd = str(b.cmd, 20);
        if (cmd === "cleardiag") {
          const scr = db.screens.find((x: Json) => x.id === r1);
          if (!scr) return err("Écran introuvable", 404);
          scr.diagClearedAt = Date.now();
          await saveDb(db);
          return json({ ok: true });
        }
        if (!["reload", "identify"].includes(cmd)) return err("Commande inconnue");
        const targets = r1 === "all" ? db.screens : db.screens.filter((x: Json) => x.id === r1);
        const c = { id: uid(), cmd, at: Date.now() };
        targets.forEach((x: Json) => { x.cmd = c; });
        await saveDb(db);
        return json({ ok: true, sent: targets.length });
      }
      const scr = db.screens.find((x: Json) => x.id === r1);
      if (!scr) return err("Écran introuvable", 404);
      if (M === "PUT") {
        const b = await body();
        if ("name" in b) scr.name = str(b.name, 80).trim() || scr.name;
        if ("location" in b) scr.location = str(b.location, 120);
        if ("playlistId" in b) scr.playlistId = db.playlists.some((p: Json) => p.id === b.playlistId) ? b.playlistId : null;
        if ("orientation" in b) scr.orientation = [0, 90, 180, 270].includes(Number(b.orientation)) ? Number(b.orientation) : 0;
        if ("ticker" in b) scr.ticker = str(b.ticker, 1000);
        if ("margin" in b) scr.margin = num(b.margin, 0, 0, 10);
        if ("showClock" in b) scr.showClock = !!b.showClock;
        if (Array.isArray(b.schedules)) {
          scr.schedules = b.schedules
            .filter((r: Json) => db.playlists.some((p: Json) => p.id === r.playlistId))
            .slice(0, 50)
            .map((r: Json) => ({
              id: str(r.id, 20) || uid(), playlistId: r.playlistId,
              days: (Array.isArray(r.days) ? r.days : []).map(Number).filter((d: number) => d >= 1 && d <= 7),
              start: hhmm(r.start, "08:00"), end: hhmm(r.end, "17:00"),
            }));
        }
        await saveDb(db);
        return json(scr);
      }
      if (M === "DELETE") {
        db.screens = db.screens.filter((x: Json) => x.id !== scr.id);
        await saveDb(db);
        return json({ ok: true });
      }
    }

    /* ---- envoi de médias en morceaux ---- */
    if (r0 === "upload") {
      if (r1 === "init" && M === "POST") {
        const b = await body();
        const mime = str(b.mime, 100), size = Number(b.size);
        if (!/^(image|video)\//.test(mime)) return err("Seules les images et les vidéos sont acceptées");
        if (!Number.isFinite(size) || size <= 0) return err("Fichier vide");
        if (size > MAX_MEDIA) return err("Fichier trop lourd (300 Mo maximum)");
        return json({ id: uid(), chunkSize: CHUNK, chunks: Math.ceil(size / CHUNK) });
      }
      if (isId(r1) && /^\d{1,4}$/.test(r2 || "") && M === "PUT") {
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > CHUNK) return err("Morceau invalide");
        await s.set(`m/${r1}/${Number(r2)}`, buf);
        return json({ ok: true });
      }
      if (isId(r1) && r2 === "done" && M === "POST") {
        const b = await body();
        const mime = str(b.mime, 100), size = Number(b.size), chunks = Math.ceil(size / CHUNK);
        if (!/^(image|video)\//.test(mime)) return err("Type de fichier invalide");
        const { blobs } = await s.list({ prefix: `m/${r1}/` });
        if (blobs.length !== chunks) return err(`Envoi incomplet (${blobs.length}/${chunks} morceaux)`);
        await s.setJSON(`meta/${r1}`, { mime, size, chunks, chunkSize: CHUNK });
        // diapositive d'un diaporama : stockée seule, le contenu « slides » est créé ensuite
        if (b.slide === true) {
          if (!mime.startsWith("image/")) return err("Une diapositive doit être une image");
          return json({ id: r1, file: `/media/${r1}`, size });
        }
        const isVideo = mime.startsWith("video/");
        const c = {
          id: r1, type: isVideo ? "video" : "image", name: str(b.name, 80).replace(/\.[^.]+$/, "") || "Média",
          file: `/media/${r1}`, mime, size, duration: isVideo ? 0 : 10, fit: "contain", muted: true, createdAt: Date.now(),
        };
        const db = await getDb();
        db.contents.push(c);
        await saveDb(db);
        return json(c);
      }
    }

    /* ---- contenus ---- */
    if (r0 === "contents") {
      const db = await getDb();
      if (!r1 && M === "POST") {
        const b = await body();
        const type = str(b.type, 20);
        if (!["text", "web", "youtube", "clock", "slides"].includes(type)) return err("Type inconnu");
        const c: Json = { id: uid(), type, name: "Sans titre", duration: 15, createdAt: Date.now() };
        if (type === "slides") {
          const ids = Array.isArray(b.mediaIds) ? b.mediaIds.filter(isId).slice(0, 200) : [];
          if (!ids.length) return err("Aucune diapositive");
          const metas = await Promise.all(ids.map((id: string) => s.get(`meta/${id}`, { type: "json" }) as Promise<Json | null>));
          if (metas.some(m => !m)) return err("Diapositive manquante : relancez l'import");
          Object.assign(c, {
            mediaIds: ids, slides: ids.map((id: string) => `/media/${id}`), fit: "contain", duration: 10,
            size: metas.reduce((a, m) => a + (m!.size || 0), 0),
          });
        }
        if (type === "text") Object.assign(c, { title: "", body: "", bg: "#1d3557", fg: "#ffffff", accent: "#f4a261" });
        try { applyContentFields(c, b); } catch (e: any) { return err(e.message); }
        if ((type === "web" || type === "youtube") && !c.url) return err("Adresse manquante");
        db.contents.push(c);
        await saveDb(db);
        return json(c);
      }
      const c = db.contents.find((x: Json) => x.id === r1);
      if (!c) return err("Contenu introuvable", 404);
      if (M === "PUT") {
        try { applyContentFields(c, await body()); } catch (e: any) { return err(e.message); }
        await saveDb(db);
        return json(c);
      }
      if (M === "DELETE") {
        db.contents = db.contents.filter((x: Json) => x.id !== c.id);
        for (const p of db.playlists) p.items = p.items.filter((it: Json) => it.contentId !== c.id);
        await saveDb(db);
        if (c.type === "image" || c.type === "video") context.waitUntil(deleteMedia(c.id));
        if (c.type === "slides") context.waitUntil(Promise.all((c.mediaIds || []).map((id: string) => deleteMedia(id))));
        return json({ ok: true });
      }
    }

    /* ---- playlists ---- */
    if (r0 === "playlists") {
      const db = await getDb();
      if (!r1 && M === "POST") {
        const b = await body();
        const p = { id: uid(), name: str(b.name, 80).trim() || "Nouvelle playlist", items: [] };
        db.playlists.push(p);
        await saveDb(db);
        return json(p);
      }
      const p = db.playlists.find((x: Json) => x.id === r1);
      if (!p) return err("Playlist introuvable", 404);
      if (M === "PUT") {
        const b = await body();
        if ("name" in b) p.name = str(b.name, 80).trim() || p.name;
        if (Array.isArray(b.items)) {
          p.items = b.items
            .filter((it: Json) => db.contents.some((c: Json) => c.id === it.contentId))
            .slice(0, 500)
            .map((it: Json) => ({ contentId: it.contentId, duration: num(it.duration, 10) }));
        }
        await saveDb(db);
        return json(p);
      }
      if (M === "DELETE") {
        db.playlists = db.playlists.filter((x: Json) => x.id !== p.id);
        for (const x of db.screens) {
          if (x.playlistId === p.id) x.playlistId = null;
          x.schedules = (x.schedules || []).filter((r: Json) => r.playlistId !== p.id);
        }
        await saveDb(db);
        return json({ ok: true });
      }
    }

    if (r0 === "preview" && M === "GET") {
      const db = await getDb();
      const r = resolvePlaylist(db, r1);
      if (!r) return err("Playlist introuvable", 404);
      return json({ playlists: { [r.id]: r }, settings: db.settings });
    }

    /* ---- alerte ---- */
    if (r0 === "alert") {
      const db = await getDb();
      if (M === "POST") {
        const b = await body();
        const message = str(b.message, 1000).trim();
        if (!message) return err("Message vide");
        const level = b.level === "info" ? "info" : "urgence";
        db.alert = { level, title: str(b.title, 120).trim() || (level === "info" ? "Information" : "ALERTE"), message, at: Date.now() };
        await saveDb(db);
        return json(db.alert);
      }
      if (M === "DELETE") { db.alert = null; await saveDb(db); return json({ ok: true }); }
    }

    /* ---- mot de passe du compte connecté ---- */
    if (r0 === "password" && M === "POST") {
      const b = await body();
      const nw = str(b.password, 200);
      if (nw.length < 8) return err("Le mot de passe doit faire au moins 8 caractères");
      if (sameHex(scrypt(nw, me.salt), me.hash)) return err("Choisissez un mot de passe différent de l'actuel");
      if (WEAK.includes(nw.toLowerCase())) return err("Mot de passe trop facile à deviner");
      const users = await getUsers();
      const u = users.find(x => x.id === me.id)!;
      u.salt = randomBytes(16).toString("hex"); u.hash = scrypt(nw, u.salt); u.mustChange = false;
      await saveUsers(users);
      return json({ token: await tokenFor(u) });   // les autres sessions de ce compte sont déconnectées
    }

    /* ---- comptes administrateurs ---- */
    if (r0 === "users") {
      const users = await getUsers();
      if (!r1 && M === "POST") {
        const b = await body();
        const login = cleanLogin(b.login), name = str(b.name, 80).trim(), pw = str(b.password, 200);
        if (!/^[a-z0-9._-]{3,40}$/.test(login)) return err("Identifiant : 3 à 40 caractères (lettres sans accent, chiffres, . _ -)");
        if (!name) return err("Indiquez le nom de la personne");
        if (pw.length < 8) return err("Mot de passe provisoire : 8 caractères minimum");
        if (users.some(x => x.login === login)) return err("Cet identifiant existe déjà");
        const salt = randomBytes(16).toString("hex");
        const u = { id: uid(), login, name, salt, hash: scrypt(pw, salt), mustChange: true, createdAt: Date.now(), createdBy: me.login };
        users.push(u); await saveUsers(users);
        return json(publicUser(u));
      }
      const u = users.find(x => x.id === r1);
      if (!u) return err("Compte introuvable", 404);
      if (r2 === "reset" && M === "POST") {
        const pw = str((await body()).password, 200);
        if (pw.length < 8) return err("Mot de passe provisoire : 8 caractères minimum");
        u.salt = randomBytes(16).toString("hex"); u.hash = scrypt(pw, u.salt); u.mustChange = true;
        await saveUsers(users);
        return json(publicUser(u));
      }
      if (!r2 && M === "DELETE") {
        if (u.id === me.id) return err("Vous ne pouvez pas supprimer votre propre compte");
        await saveUsers(users.filter(x => x.id !== u.id));
        return json({ ok: true });
      }
    }

    /* ---- réglages ---- */
    if (r0 === "settings" && M === "PUT") {
      const db = await getDb();
      const b = await body();
      if ("schoolName" in b) db.settings.schoolName = str(b.schoolName, 120).trim();
      await saveDb(db);
      return json(db.settings);
    }

    return err("Route inconnue", 404);
  } catch (e: any) {
    console.error(e);
    return err(e?.message || "Erreur serveur", 500);
  }
};

export const config: Config = { path: "/api/*" };
