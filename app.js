// Gemeinsame Logik für Upload-Seite und Verwaltung.
// Spricht entweder mit Supabase (Cloud) oder – im Demo-Modus – mit localStorage.
(function () {
  "use strict";
  const C = window.ABI_CONFIG || {};
  const DEMO = !C.supabaseUrl || !C.supabaseAnonKey;
  const BUCKET = "photos";

  // ---------- Bildverarbeitung ----------
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function toJpeg(src, maxEdge, quality) {
    const w = src.width, h = src.height;
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const cw = Math.round(w * s), ch = Math.round(h * s);
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, cw, ch);
    return new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", quality));
  }

  // Liefert {full, thumb} als JPEG-Blobs. Kann der Browser das Bild nicht lesen
  // (z. B. HEIC in Chrome), wird das Original hochgeladen und thumb ist null.
  async function prepareImage(file, opts = {}) {
    const maxEdge = opts.maxEdge || 2400;
    try {
      const bmp = await decode(file);
      const full = await toJpeg(bmp, maxEdge, 0.9);
      const thumb = await toJpeg(bmp, 480, 0.8);
      if (bmp.close) bmp.close();
      return { full, thumb, ext: "jpg", type: "image/jpeg" };
    } catch (_) {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
      return { full: file, thumb: null, ext, type: file.type || "application/octet-stream" };
    }
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  // ---------- Namen sortieren ----------
  const collator = new Intl.Collator("de", { sensitivity: "base" });
  function lastName(n) { const p = n.trim().split(/\s+/); return p[p.length - 1]; }
  function sortStudents(list, mode = "last") {
    const arr = list.slice();
    if (mode === "first") arr.sort((a, b) => collator.compare(a.name, b.name));
    else if (mode === "random") {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    } else arr.sort((a, b) => collator.compare(lastName(a.name), lastName(b.name)) || collator.compare(a.name, b.name));
    return arr;
  }

  // ============================================================
  //  Supabase-Backend
  // ============================================================
  function supabaseApi() {
    const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);
    const must = ({ data, error }) => { if (error) throw error; return data; };

    return {
      demo: false,
      async listStudents() {
        return must(await sb.from("students").select("id,name").order("name"));
      },
      async submit({ studentId, file, parentName, note }, onStep) {
        onStep && onStep("Foto wird vorbereitet …");
        const img = await prepareImage(file);
        const base = `${studentId}/${uuid()}`;
        const path = `${base}.${img.ext}`;
        const thumbPath = img.thumb ? `${base}_thumb.jpg` : null;
        onStep && onStep("Foto wird hochgeladen …");
        must(await sb.storage.from(BUCKET).upload(path, img.full, { contentType: img.type, upsert: false }));
        if (thumbPath) {
          must(await sb.storage.from(BUCKET).upload(thumbPath, img.thumb, { contentType: "image/jpeg", upsert: false }));
        }
        must(await sb.from("submissions").insert({
          student_id: studentId, path, thumb_path: thumbPath,
          parent_name: parentName || null, note: note || null,
        }));
      },

      // --- Verwaltung ---
      async session() { return (await sb.auth.getSession()).data.session; },
      async signIn(email, password) {
        must(await sb.auth.signInWithPassword({ email, password }));
      },
      async signOut() { await sb.auth.signOut(); },
      async isAdmin() { return !!must(await sb.rpc("is_admin")); },
      async listSubmissions() {
        return must(await sb.from("submissions")
          .select("id,student_id,path,thumb_path,parent_name,note,chosen,created_at")
          .order("created_at"));
      },
      async signUrls(paths) {
        const out = {};
        const list = paths.filter(Boolean);
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100);
          const data = must(await sb.storage.from(BUCKET).createSignedUrls(chunk, 60 * 60 * 12));
          data.forEach((d) => { if (d.signedUrl) out[d.path] = d.signedUrl; });
        }
        return out;
      },
      async deleteSubmission(sub) {
        must(await sb.storage.from(BUCKET).remove([sub.path, sub.thumb_path].filter(Boolean)));
        must(await sb.from("submissions").delete().eq("id", sub.id));
      },
      async setChosen(sub) {
        must(await sb.from("submissions").update({ chosen: false }).eq("student_id", sub.student_id));
        must(await sb.from("submissions").update({ chosen: true }).eq("id", sub.id));
      },
      async addStudents(names) {
        must(await sb.from("students").insert(names.map((name) => ({ name }))));
      },
      async renameStudent(id, name) {
        must(await sb.from("students").update({ name }).eq("id", id));
      },
      async deleteStudent(id, subs) {
        const paths = subs.flatMap((s) => [s.path, s.thumb_path]).filter(Boolean);
        if (paths.length) must(await sb.storage.from(BUCKET).remove(paths));
        must(await sb.from("students").delete().eq("id", id));
      },
    };
  }

  // ============================================================
  //  Demo-Backend (nur lokal, zum Ausprobieren)
  // ============================================================
  function demoApi() {
    const KEY = "abi_demo_v1";
    const SEED = ["Anna Becker", "Ben Schulz", "Clara Wagner", "David Hoffmann", "Emma Fischer",
      "Felix Weber", "Greta Schäfer", "Henri Koch", "Ida Richter", "Jonas Klein"];
    function load() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY));
        if (s && s.students) return s;
      } catch (_) {}
      return { nextId: SEED.length + 1, students: SEED.map((name, i) => ({ id: i + 1, name })), subs: [] };
    }
    function save(s) {
      try { localStorage.setItem(KEY, JSON.stringify(s)); }
      catch (_) { throw new Error("Demo-Speicher voll – bitte im Demo-Modus nur wenige Fotos testen."); }
    }
    const files = {}; // path -> dataUrl (in state gespeichert)

    return {
      demo: true,
      async listStudents() { return load().students.slice(); },
      async submit({ studentId, file, parentName, note }, onStep) {
        onStep && onStep("Foto wird vorbereitet …");
        const img = await prepareImage(file, { maxEdge: 1200 });
        const s = load();
        const id = uuid();
        const full = await blobToDataUrl(img.full);
        const thumb = img.thumb ? await blobToDataUrl(img.thumb) : null;
        s.subs.push({ id, student_id: studentId, path: `${studentId}/${id}.${img.ext}`,
          thumb_path: thumb ? `${studentId}/${id}_thumb.jpg` : null, _full: full, _thumb: thumb,
          parent_name: parentName || null, note: note || null, chosen: false,
          created_at: new Date().toISOString() });
        onStep && onStep("Foto wird hochgeladen …");
        await new Promise((r) => setTimeout(r, 400));
        save(s);
      },
      async session() { return sessionStorage.getItem("abi_demo_login") ? { demo: true } : null; },
      async signIn() { sessionStorage.setItem("abi_demo_login", "1"); },
      async signOut() { sessionStorage.removeItem("abi_demo_login"); },
      async isAdmin() { return true; },
      async listSubmissions() {
        const s = load();
        s.subs.forEach((x) => { files[x.path] = x._full; if (x.thumb_path) files[x.thumb_path] = x._thumb; });
        return s.subs.map(({ _full, _thumb, ...rest }) => rest);
      },
      async signUrls(paths) {
        const out = {};
        paths.filter(Boolean).forEach((p) => { if (files[p]) out[p] = files[p]; });
        return out;
      },
      async deleteSubmission(sub) {
        const s = load(); s.subs = s.subs.filter((x) => x.id !== sub.id); save(s);
      },
      async setChosen(sub) {
        const s = load();
        s.subs.forEach((x) => { if (x.student_id === sub.student_id) x.chosen = x.id === sub.id; });
        save(s);
      },
      async addStudents(names) {
        const s = load();
        names.forEach((name) => s.students.push({ id: s.nextId++, name }));
        save(s);
      },
      async renameStudent(id, name) {
        const s = load(); const st = s.students.find((x) => x.id === id); if (st) st.name = name; save(s);
      },
      async deleteStudent(id) {
        const s = load();
        s.students = s.students.filter((x) => x.id !== id);
        s.subs = s.subs.filter((x) => x.student_id !== id);
        save(s);
      },
    };
  }

  // ---------- Hilfen für die Seiten ----------
  function $(sel, root = document) { return root.querySelector(sel); }
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    children.flat().forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); });
    return n;
  }
  function errorText(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/Invalid login credentials/i.test(m)) return "E-Mail oder Passwort ist falsch.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Keine Verbindung zum Server. Bitte Internetverbindung prüfen.";
    if (/exceeded the maximum allowed size|Payload too large/i.test(m)) return "Die Datei ist zu groß.";
    if (/mime type/i.test(m)) return "Dieses Dateiformat wird nicht unterstützt. Bitte ein JPG- oder PNG-Foto wählen.";
    return m;
  }

  function fillTexts() {
    document.querySelectorAll("[data-cfg]").forEach((n) => {
      const v = C[n.dataset.cfg];
      if (v) n.textContent = v;
      else if (n.hasAttribute("data-hide-empty")) n.hidden = true;
    });
    document.querySelectorAll("[data-cfg-wrap]").forEach((n) => { if (!C[n.dataset.cfgWrap]) n.hidden = true; });
    if (DEMO) document.querySelectorAll(".demo-banner").forEach((n) => (n.hidden = false));
  }

  window.Abi = {
    config: C, demo: DEMO,
    api: DEMO ? demoApi() : supabaseApi(),
    sortStudents, lastName, $, el, errorText, fillTexts,
  };
})();
