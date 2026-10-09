// Kino plugin: Bilibili (versión inicial)
// Busca videos y obtiene streams básicos.

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.bilibili.com",
};

function log(...args) {
  try { kino.log(...args); } catch {}
}

async function getJson(url) {
  const r = await kino.fetch(url, { headers: HEADERS });
  if (!r.ok) throw kino.error("unavailable", "Bilibili respondió " + r.status);
  const data = r.json();
  if (data.code !== 0 && data.code !== undefined) {
    throw kino.error("unavailable", data.message || "Error de Bilibili");
  }
  return data;
}

// ---------- SEARCH ----------
export async function search(query) {
  const q = (query.q || "").trim();
  if (!q) return [];

  const url = API + "/x/web-interface/search/type?search_type=video&keyword=" +
    encodeURIComponent(q) + "&page=1&pagesize=20";

  const data = await getJson(url);
  const list = (data.data && data.data.result) || [];

  return list.map((v) => ({
    id: String(v.bvid || v.aid),
    ref: v.bvid || ("av" + v.aid),
    title: (v.title || "").replace(/<[^>]+>/g, ""),
    kind: "movie",
    poster: v.pic ? (v.pic.startsWith("//") ? "https:" + v.pic : v.pic) : undefined,
    year: v.pubdate ? String(new Date(v.pubdate * 1000).getFullYear()) : undefined,
    overview: (v.description || "").slice(0, 300),
  }));
}

// ---------- HOME ----------
export async function home() {
  // Ranking popular (todo)
  const url = API + "/x/web-interface/ranking/v2?rid=0&type=all";
  const data = await getJson(url);
  const list = (data.data && data.data.list) || [];

  const items = list.slice(0, 20).map((v) => ({
    id: String(v.bvid || v.aid),
    ref: v.bvid || ("av" + v.aid),
    title: v.title || "",
    kind: "movie",
    poster: v.pic ? (v.pic.startsWith("//") ? "https:" + v.pic : v.pic) : undefined,
  }));

  return [
    {
      id: "popular",
      title: "Populares en Bilibili",
      items,
    },
  ];
}

// ---------- RESOLVE ----------
export async function resolve(ref) {
  // ref puede ser BVxxxx o av123456
  let bvid = null;
  let aid = null;

  if (ref.startsWith("BV")) {
    bvid = ref;
  } else if (ref.startsWith("av")) {
    aid = ref.slice(2);
  } else {
    bvid = ref;
  }

  // 1. Obtener cid
  let viewUrl = API + "/x/web-interface/view?";
  if (bvid) viewUrl += "bvid=" + encodeURIComponent(bvid);
  else viewUrl += "aid=" + encodeURIComponent(aid);

  const view = await getJson(viewUrl);
  const videoData = view.data;
  if (!videoData) throw kino.error("not_found", "Video no encontrado");

  const cid = videoData.cid;
  const realBvid = videoData.bvid;
  const realAid = videoData.aid;

  // 2. Obtener playurl (calidad baja primero, sin login)
  const playUrl = API + "/x/player/playurl?bvid=" + encodeURIComponent(realBvid) +
    "&cid=" + cid + "&qn=64&fnval=16&fourk=1";

  const play = await getJson(playUrl);
  const d = play.data;

  // Preferir DASH si existe
  if (d.dash && d.dash.video && d.dash.video.length) {
    const video = d.dash.video[0];
    const audio = d.dash.audio && d.dash.audio[0];

    // Por ahora devolvemos el video (Kino aún no une video+audio DASH fácilmente)
    // Usamos el primer stream disponible
    return {
      url: video.baseUrl || video.base_url,
      headers: {
        "Referer": "https://www.bilibili.com",
        "User-Agent": HEADERS["User-Agent"],
      },
      // expiresInSeconds: 7000, // ~2 horas
    };
  }

  // Fallback a durl (flv/mp4)
  if (d.durl && d.durl.length) {
    return {
      url: d.durl[0].url,
      headers: {
        "Referer": "https://www.bilibili.com",
        "User-Agent": HEADERS["User-Agent"],
      },
    };
  }

  throw kino.error("unavailable", "No se pudo obtener el stream");
}
