/**
 * Affichage — diffusion des médias stockés en morceaux dans Netlify Blobs.
 * - Fichiers ≤ 18 Mo : renvoyés entiers (et mis en cache durable sur le CDN).
 * - Fichiers plus gros : réponses partielles (Range) par morceau de 3 Mo, comme le demandent les lecteurs vidéo.
 */
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const FULL_LIMIT = 18 * 1024 * 1024;

export default async (req: Request, context: Context) => {
  const id = context.params?.id || decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  if (!/^[a-f0-9]{12}$/.test(id || "")) return new Response("Introuvable", { status: 404 });
  const s = getStore({ name: "affichage", consistency: "strong" });
  const meta = (await s.get(`meta/${id}`, { type: "json" })) as
    | { mime: string; size: number; chunks: number; chunkSize: number } | null;
  if (!meta) return new Response("Introuvable", { status: 404 });

  const { mime, size, chunks, chunkSize } = meta;
  const base: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  const getChunk = async (i: number) => {
    const buf = (await s.get(`m/${id}/${i}`, { type: "arrayBuffer" })) as ArrayBuffer | null;
    if (!buf) throw new Error(`Morceau ${i} manquant`);
    return buf;
  };

  const range = req.headers.get("range");
  if (size <= FULL_LIMIT || !range) {
    const headers = { ...base, "Content-Length": String(size), "Netlify-CDN-Cache-Control": "public, durable, max-age=31536000, immutable" };
    if (chunks === 1) return new Response(await getChunk(0), { headers });
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (i >= chunks) return ctrl.close();
        try { ctrl.enqueue(new Uint8Array(await getChunk(i++))); } catch (e) { ctrl.error(e); }
      },
    });
    return new Response(stream, { headers });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  let start: number, end: number;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2] || 0)); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });

  const ci = Math.floor(start / chunkSize);
  end = Math.min(end, (ci + 1) * chunkSize - 1);       // une réponse = un seul morceau
  const buf = await getChunk(ci);
  const part = buf.slice(start - ci * chunkSize, end - ci * chunkSize + 1);
  return new Response(part, {
    status: 206,
    headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(part.byteLength) },
  });
};

export const config: Config = { path: "/media/:id", method: ["GET", "HEAD"] };
