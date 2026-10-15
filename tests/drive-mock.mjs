// Shared mocks for the Drive e2e tests: Google Identity Services + an in-page Drive v3 fake.
// Stand-in for https://accounts.google.com/gsi/client (served for that URL).
export const GIS_MOCK = `
(() => {
  const G = (window.__gis = window.__gis || { mode: "ok", requests: [], tokenN: 0, revoked: [], inits: [] });
  window.google = { accounts: { oauth2: {
    initTokenClient(cfg) {
      G.inits.push({ client_id: cfg.client_id, scope: cfg.scope });
      return { requestAccessToken(o = {}) {
        G.requests.push({ ...o, hasPrompt: "prompt" in o });
        setTimeout(() => {
          if (G.mode === "blockSilent" && o.prompt === "") return cfg.error_callback({ type: "popup_failed_to_open" });
          if (G.mode === "closed") return cfg.error_callback({ type: "popup_closed" });
          cfg.callback({ access_token: "tok-" + (++G.tokenN), expires_in: 3599, scope: cfg.scope, token_type: "Bearer" });
        }, 30);
      } };
    },
    hasGrantedAllScopes(r, s) { return String(r.scope || "").split(" ").includes(s); },
    revoke(t, cb) { G.revoked.push(t); cb && cb(); },
  } } };
})();`;

// In-page fake of the Drive v3 API, installed as a fetch wrapper for googleapis.com.
export function installFakeDrive() {
  const D = (window.__drive = { files: {}, n: 0, log: [], fail: [], offline: false, expired: [] });
  const realFetch = window.fetch.bind(window);
  const reply = (status, body, headers = {}) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const newId = () => `id${++D.n}`;
  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed, modifiedTime: f.modifiedTime, size: String(f.content.length), ...(f.appProperties ? { appProperties: f.appProperties } : {}) });
  const touch = (f) => { f.modifiedTime = new Date(Math.max(Date.now(), (D.clock = (D.clock || 0) + 1))).toISOString(); };
  const store = (fields) => { const f = { id: newId(), trashed: false, content: "", rev: 0, ...fields }; touch(f); D.files[f.id] = f; return f; };
  const qval = (qs, re) => { const m = re.exec(qs); return m ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null; };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://www.googleapis.com/")) return realFetch(input, init);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const entry = { method, url, auth: headers.Authorization || "", ct: headers["Content-Type"] || "", at: Date.now() };
    D.log.push(entry);
    if (D.offline) { entry.status = "network"; throw new TypeError("Failed to fetch"); }
    const done = (res) => { entry.status = res.status; return res; };
    if (D.expired.includes(entry.auth)) return done(reply(401, { error: { code: 401, message: "Invalid Credentials" } }));
    const fi = D.fail.findIndex((x) => x.method === method && (!x.urlIncludes || url.includes(x.urlIncludes)));
    if (fi >= 0) { const x = D.fail[fi]; if (--x.times <= 0) D.fail.splice(fi, 1); return done(reply(x.status, { error: { code: x.status, message: "mock " + x.status } })); }
    const u = new URL(url);
    const body = init.body == null ? "" : await new Response(init.body).text();
    entry.size = body.length;
    const p = u.pathname;
    if (p === "/drive/v3/about") return done(reply(200, { user: { emailAddress: "tim@example.com" } }));
    if (p === "/drive/v3/files" && method === "GET") {
      const qs = u.searchParams.get("q") || "";
      const name = qval(qs, /name='((?:[^'\\]|\\.)*)'/);
      const mime = qval(qs, /mimeType='([^']*)'/);
      const parent = qval(qs, /'((?:[^'\\]|\\.)*)' in parents/);
      const hit = Object.values(D.files).filter((f) => !f.trashed && (!name || f.name === name) && (!mime || f.mimeType === mime) && (!parent || f.parents.includes(parent)));
      entry.search = { name, parent };
      return done(reply(200, { files: hit.slice(0, 1).map((f) => ({ id: f.id, name: f.name })) }));
    }
    if (p === "/drive/v3/files" && method === "POST") {
      const m = JSON.parse(body);
      const f = store({ name: m.name, mimeType: m.mimeType, parents: m.parents || [] });
      entry.created = f.id;
      return done(reply(200, { id: f.id }));
    }
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m && method === "GET") {
      const f = D.files[m[1]];
      if (!f) return done(reply(404, { error: { code: 404, message: "File not found" } }));
      if (u.searchParams.get("alt") === "media") { entry.download = f.id; return done(new Response(f.content, { status: 200, headers: { "Content-Type": f.mimeType } })); }
      return done(reply(200, meta(f)));
    }
    if (m && method === "PATCH") {
      const f = D.files[m[1]];
      if (!f) return done(reply(404, { error: { code: 404, message: "File not found" } }));
      const md = JSON.parse(body || "{}");
      if (md.appProperties) f.appProperties = { ...(f.appProperties || {}), ...md.appProperties };
      entry.metaPatch = f.id;
      return done(reply(200, meta(f)));
    }
    if (p === "/upload/drive/v3/files" && method === "POST") {
      const type = u.searchParams.get("uploadType");
      entry.uploadType = type;
      if (type === "multipart") {
        const b = /boundary=([^;]+)/.exec(entry.ct)[1];
        const parts = body.split(`--${b}`).slice(1, -1).map((part) => { const i = part.indexOf("\r\n\r\n"); return { head: part.slice(0, i), data: part.slice(i + 4, -2) }; });
        const md = JSON.parse(parts[0].data);
        const parentOk = (md.parents || []).every((pid) => pid === "root" || (D.files[pid] && !D.files[pid].trashed));
        if (!parentOk) return done(reply(404, { error: { code: 404, message: "File not found: parent" } }));
        const f = store({ name: md.name, mimeType: md.mimeType, parents: md.parents || [], content: parts[1].data, partType: /Content-Type: ([^\r\n]+)/.exec(parts[1].head)[1] });
        entry.created = f.id;
        return done(reply(200, meta(f)));
      }
      if (type === "resumable") {
        const md = JSON.parse(body || "{}");
        const f = store({ name: md.name, mimeType: md.mimeType, parents: md.parents || [], pending: true });
        entry.created = f.id;
        return done(reply(200, {}, { Location: `https://www.googleapis.com/upload/session/${f.id}` }));
      }
    }
    m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m && method === "PATCH") {
      const f = D.files[m[1]];
      entry.uploadType = u.searchParams.get("uploadType");
      entry.target = m[1];
      if (!f) return done(reply(404, { error: { code: 404, message: "File not found: " + m[1] } }));
      if (entry.uploadType === "resumable") return done(reply(200, {}, { Location: `https://www.googleapis.com/upload/session/${f.id}` }));
      f.content = body; f.rev += 1; f.lastType = entry.ct; touch(f);
      return done(reply(200, meta(f)));
    }
    m = /^\/upload\/session\/([^/]+)$/.exec(p);
    if (m && method === "PUT") { const f = D.files[m[1]]; f.content = body; f.rev += 1; delete f.pending; touch(f); entry.target = f.id; return done(reply(200, meta(f))); }
    return done(reply(400, { error: { code: 400, message: "mock: unhandled " + method + " " + p } }));
  };
}

