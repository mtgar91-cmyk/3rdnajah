/* =====================================================================
   موقع نتائج الطلاب + لوحة تحكم + بوت تيليجرام  (Cloudflare Worker)
   التخزين: KV باسم DB
   الأسرار: BOT_TOKEN , WEBHOOK_SECRET      المتغيرات: ADMIN_IDS
   ===================================================================== */

const DEFAULT_T = {
  country: 'جمهورية العراق',
  ministry: 'وزارة التربية - اللجنة الدائمة للامتحانات العامة',
  subtitle: 'منصة إعلان النتائج',
  searchLabel: 'اسم الطالب الثلاثي',
  searchPlaceholder: 'اكتب اسمك الثلاثي',
  searchBtn: 'إظهار النتيجة',
  errShort: 'يرجى كتابة الاسم الثلاثي كاملاً',
  errNotFound: 'لم يتم العثور على نتيجة بهذا الاسم، تأكد من كتابة اسمك الثلاثي بشكل صحيح.',
  errServer: 'حدث خطأ، حاول مرة أخرى',
  committee: 'لجنة الاختبارات',
  title: 'نتائج الاختبارات للعام الدراسي 2025 - 2026',
  section: 'معلومات الطالب',
  tableTitle: 'النتيجة',
  lName: 'الاسم:',
  lSchool: 'المدرسة:',
  schoolName: 'اسم المدرسة',
  note: 'يُعد هذا تبليغاً بنتيجة الطالب فقط، ولا يُعتبر **وثيقة رسمية** معتمدة لأي غرض كان.',
  thSubj: 'المادة',
  thGrade: 'الدرجة',
  ofText: 'من',
  btnPrint: '🖨️ طباعة النتيجة',
  btnBack: '↩️ العودة للصفحة الرئيسية',
  panelBar: 'لوحة التحكم',
  boxText: 'نتيجتك بانتظارك',
  boxStyle: 'wave'
};
const DEFAULT_COLORS = {
  primary: '#3b82f6', bg: '#f4f6fb', card: '#ffffff', text: '#333333',
  muted: '#888888', fail: '#e53935', btn2: '#4caf50'
};
const DEFAULT_SETTINGS = {
  t: DEFAULT_T, colors: DEFAULT_COLORS,
  logo: '', boxImage: '', noteIcon: '',
  examMax: 0, passPercent: 50, subjects: []
};

/* ------------------------------ أدوات عامة ------------------------------ */
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS }
  });
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return [...a].map(x => chars[x % chars.length]).join('');
}
const AR_DIAC = /[\u064B-\u065F\u0670\u0640]/g;
function digits(s) {
  return String(s)
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}
function fold(s) { // تبديل حرف بحرف (يحافظ على الطول)
  return s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
function normName(s) {
  return fold(digits(s).replace(AR_DIAC, '')).replace(/\s+/g, ' ').trim().toLowerCase();
}
function firstThree(n) { return n.split(' ').slice(0, 3).join(' '); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function clean(s, max) { return String(s == null ? '' : s).slice(0, max); }

/* ------------------------------ التخزين ------------------------------ */
async function getSettings(env) {
  const s = (await env.DB.get('settings', 'json')) || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    t: { ...DEFAULT_T, ...(s.t || {}) },
    colors: { ...DEFAULT_COLORS, ...(s.colors || {}) },
    subjects: Array.isArray(s.subjects) ? s.subjects : []
  };
}
async function putSettings(env, s) { await env.DB.put('settings', JSON.stringify(s)); }
async function getStudents(env) { return (await env.DB.get('students', 'json')) || []; }
async function putStudents(env, a) { await env.DB.put('students', JSON.stringify(a)); }
async function getState(env) {
  return { visible: false, code: '', epoch: 1, ...((await env.DB.get('state', 'json')) || {}) };
}
async function putState(env, st) { await env.DB.put('state', JSON.stringify(st)); }

function publicSettings(s) { const { subjects, ...rest } = s; return rest; }

/* ------------------------------ المصادقة ------------------------------ */
async function isAuthed(request, env) {
  const h = request.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!/^[a-f0-9]{48}$/.test(tok)) return false;
  const [st, ep] = await Promise.all([getState(env), env.DB.get('sess:' + tok)]);
  return st.visible && ep !== null && Number(ep) === st.epoch;
}

/* ------------------------------ تحليل نص الطلاب ------------------------------ */
function parseLine(raw, subjects, examMax) {
  let line = digits(raw).replace(AR_DIAC, '').replace(/[،,؛;|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const folded = fold(line);
  const subs = [...subjects].sort((a, b) => b.name.length - a.name.length);
  const alt = subs.map(s => escRe(fold(s.name.replace(AR_DIAC, '').trim())).replace(/\s+/g, '\\s+')).join('|');
  const re = new RegExp('(?:^|\\s)(' + alt + ')\\s*[:=\\-–]?\\s*(\\d+(?:\\.\\d+)?|غائب|غ)(?=\\s|$)', 'gi');
  const grades = {};
  let first = -1, m;
  while ((m = re.exec(folded))) {
    const idx = m.index + (m[0].startsWith(' ') ? 1 : 0);
    if (first < 0) first = idx;
    const nameF = m[1].replace(/\s+/g, ' ').toLowerCase();
    const sub = subs.find(s => fold(s.name.replace(AR_DIAC, '').trim()).replace(/\s+/g, ' ').toLowerCase() === nameF);
    if (sub) grades[sub.id] = m[2].startsWith('غ') ? 'غ' : m[2];
  }
  let name;
  if (first >= 0) {
    name = line.slice(0, first).trim();
  } else {
    const mm = line.match(/^(.*?)((?:\s+(?:\d+(?:\.\d+)?|غائب|غ))+)$/);
    if (!mm) return { error: 'لم يتم العثور على درجات (اكتب اسم المادة ثم الدرجة)' };
    name = mm[1].trim();
    const vals = mm[2].trim().split(/\s+/);
    if (vals.length > subjects.length) return { error: 'عدد الدرجات أكبر من عدد المواد' };
    vals.forEach((v, i) => { grades[subjects[i].id] = v.startsWith('غ') ? 'غ' : v; });
  }
  if (/\d/.test(name) || normName(name).split(' ').filter(Boolean).length < 3) {
    return { error: 'الاسم يجب أن يكون ثلاثياً على الأقل' };
  }
  for (const s of subjects) {
    const v = grades[s.id];
    const max = s.max || examMax;
    if (v !== undefined && v !== 'غ' && max && Number(v) > max) {
      return { error: 'درجة ' + s.name + ' (' + v + ') أكبر من درجة الامتحان (' + max + ')' };
    }
  }
  return { name: name.replace(/\s+/g, ' '), grades };
}

/* ------------------------------ بوت تيليجرام ------------------------------ */
function tg(env, method, body) {
  return fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}
function isAdminId(env, id) {
  return String(env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(String(id));
}
function panelView(st) {
  if (st.visible) {
    return {
      text: '🎛 <b>لوحة التحكم</b>\nالحالة: ظاهرة أعلى الموقع ✅\n\nالرمز السري:\n<code>' + st.code +
        '</code>\n\nاضغط على زر «لوحة التحكم» أعلى الموقع وأدخل هذا الرمز.',
      reply_markup: { inline_keyboard: [[{ text: '⛔ إيقاف إظهار لوحة التحكم', callback_data: 'hide' }]] }
    };
  }
  return {
    text: '🎛 <b>لوحة التحكم</b>\nالحالة: مخفية\n\nاضغط الزر لإظهارها أعلى الموقع وإنشاء رمز سري جديد.',
    reply_markup: { inline_keyboard: [[{ text: '✅ إظهار لوحة التحكم', callback_data: 'show' }]] }
  };
}
async function handleTelegram(env, update) {
  const msg = update.message, cb = update.callback_query;
  const src = msg || cb;
  if (!src || !src.from) return;
  const chatId = msg ? msg.chat.id : cb.message.chat.id;

  if (!isAdminId(env, src.from.id)) {
    if (msg) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: '⛔ غير مصرح لك باستخدام هذا البوت.\nمعرّفك: ' + src.from.id +
          '\n(إذا كنت صاحب الموقع أضف هذا المعرّف إلى ADMIN_IDS)'
      });
    } else {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'غير مصرح', show_alert: true });
    }
    return;
  }

  let st = await getState(env);
  if (cb) {
    if (cb.data === 'show' && !st.visible) {
      st = { visible: true, code: genCode(), epoch: st.epoch + 1 };
      await putState(env, st);
    } else if (cb.data === 'hide' && st.visible) {
      st = { visible: false, code: '', epoch: st.epoch + 1 };
      await putState(env, st);
    }
    const v = panelView(st);
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    const r = await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup
    });
    if (!r.ok) await tg(env, 'sendMessage', { chat_id: chatId, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup });
    return;
  }
  const v = panelView(st);
  await tg(env, 'sendMessage', { chat_id: chatId, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup });
}

/* ------------------------------ المسارات ------------------------------ */
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) { return json({ error: 'server_error' }, 500); }
  }
};

async function body(request) { try { return await request.json(); } catch (e) { return {}; } }

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    let cfg;
    try {
      const [s, st] = await Promise.all([getSettings(env), getState(env)]);
      cfg = { s: publicSettings(s), panelVisible: st.visible };
    } catch (e) {
      cfg = { s: publicSettings(DEFAULT_SETTINGS), panelVisible: false, kvError: true };
    }
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\u003c');
    return new Response(HTML.replace('/*__CFG__*/null', () => cfgJson), {
      headers: { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS }
    });
  }

  /* --- تيليجرام --- */
  if (path === '/telegram' && method === 'POST') {
    const sec = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!env.WEBHOOK_SECRET || !safeEq(sec, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
    try { await handleTelegram(env, await request.json()); } catch (e) {}
    return new Response('ok');
  }
  if (path === '/setup' && method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!env.WEBHOOK_SECRET || !safeEq(key, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
    const r = await tg(env, 'setWebhook', {
      url: url.origin + '/telegram', secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query']
    });
    return new Response(await r.text(), { headers: { 'content-type': 'application/json' } });
  }

  /* --- عام --- */
  if (path === '/api/config' && method === 'GET') {
    const [s, st] = await Promise.all([getSettings(env), getState(env)]);
    return json({ s: publicSettings(s), panelVisible: st.visible });
  }

  if (path === '/api/search' && method === 'POST') {
    const b = await body(request);
    const q = normName(clean(b.name, 120));
    const words = q.split(' ').filter(Boolean);
    if (words.length < 3) return json({ error: 'short' }, 400);
    const [s, students] = await Promise.all([getSettings(env), getStudents(env)]);
    const found = students.filter(x => x.k === q || (words.length === 3 && firstThree(x.k) === q));
    const results = found.slice(0, 5).map(st => {
      const rows = [];
      for (const sub of s.subjects) {
        const g = st.g[sub.id];
        if (g === undefined) continue;
        const max = sub.max || s.examMax || 0;
        const num = parseFloat(g);
        const bad = isNaN(num) || (s.passPercent > 0 && max > 0 && num < (max * s.passPercent) / 100);
        rows.push({ n: sub.name, g, max, bad });
      }
      return { name: st.n, rows };
    });
    if (!results.length) return json({ error: 'notfound' }, 404);
    return json({ results });
  }

  /* --- دخول الأدمن --- */
  if (path === '/api/admin/login' && method === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    const rlKey = 'rl:' + ip;
    const n = parseInt((await env.DB.get(rlKey)) || '0', 10);
    if (n >= 6) return json({ error: 'locked' }, 429);
    const b = await body(request);
    const st = await getState(env);
    const code = clean(b.code, 40).trim().toUpperCase();
    if (!st.visible || !st.code || !safeEq(code, st.code)) {
      await env.DB.put(rlKey, String(n + 1), { expirationTtl: 900 });
      return json({ error: 'bad_code' }, 401);
    }
    await env.DB.delete(rlKey);
    const tok = randHex(24);
    await env.DB.put('sess:' + tok, String(st.epoch), { expirationTtl: 43200 });
    return json({ token: tok });
  }

  /* --- كل ما بعد هذا يتطلب جلسة --- */
  if (path.startsWith('/api/admin/')) {
    if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/admin/hide' && method === 'POST') {
      const st = await getState(env);
      await putState(env, { visible: false, code: '', epoch: st.epoch + 1 });
      return json({ ok: true });
    }

    if (path === '/api/admin/data' && method === 'GET') {
      const [s, students] = await Promise.all([getSettings(env), getStudents(env)]);
      return json({ settings: s, students: students.map(x => ({ id: x.id, n: x.n, g: x.g })) });
    }

    if (path === '/api/admin/settings' && method === 'PUT') {
      const b = await body(request);
      const s = await getSettings(env);
      if (b.t && typeof b.t === 'object') {
        for (const k of Object.keys(DEFAULT_T)) if (typeof b.t[k] === 'string') s.t[k] = clean(b.t[k], 600);
      }
      if (['wave', 'neon', 'glitch', 'type'].indexOf(s.t.boxStyle) < 0) s.t.boxStyle = 'wave';
      if (b.colors && typeof b.colors === 'object') {
        for (const k of Object.keys(DEFAULT_COLORS)) {
          if (/^#[0-9a-fA-F]{6}$/.test(b.colors[k] || '')) s.colors[k] = b.colors[k];
        }
      }
      for (const k of ['logo', 'boxImage', 'noteIcon']) {
        if (typeof b[k] === 'string') {
          if (b[k] === '') s[k] = '';
          else if (b[k].startsWith('data:image/') && b[k].length < 700000) s[k] = b[k];
        }
      }
      if (b.examMax !== undefined) s.examMax = Math.max(0, Math.min(10000, Number(b.examMax) || 0));
      if (b.passPercent !== undefined) s.passPercent = Math.max(0, Math.min(100, Number(b.passPercent) || 0));
      await putSettings(env, s);
      return json({ settings: s });
    }

    if (path === '/api/admin/subjects' && method === 'PUT') {
      const b = await body(request);
      const s = await getSettings(env);
      const oldIds = new Set(s.subjects.map(x => x.id));
      const seen = new Set();
      const out = [];
      for (const x of Array.isArray(b.subjects) ? b.subjects.slice(0, 60) : []) {
        const name = clean(x.name, 60).replace(/\s+/g, ' ').trim();
        const key = normName(name);
        if (!name || seen.has(key)) continue;
        seen.add(key);
        const max = Number(x.max) > 0 ? Math.min(10000, Number(x.max)) : null;
        const id = x.id && oldIds.has(x.id) ? x.id : randHex(4);
        out.push({ id, name, max });
      }
      const keep = new Set(out.map(x => x.id));
      const removed = [...oldIds].filter(id => !keep.has(id));
      s.subjects = out;
      await putSettings(env, s);
      if (removed.length) {
        const students = await getStudents(env);
        students.forEach(st => removed.forEach(id => delete st.g[id]));
        await putStudents(env, students);
      }
      return json({ subjects: out });
    }

    if (path === '/api/admin/students/bulk' && method === 'POST') {
      const b = await body(request);
      const s = await getSettings(env);
      if (!s.subjects.length) return json({ error: 'أضف المواد أولاً من نافذة المواد' }, 400);
      if (!s.examMax) return json({ error: 'حدد درجة الامتحان أولاً' }, 400);
      const lines = clean(b.text, 400000).split(/\r?\n/).slice(0, 5000);
      const students = await getStudents(env);
      const map = new Map(students.map(x => [x.k, x]));
      let added = 0, updated = 0;
      const failed = [];
      for (const raw of lines) {
        if (!raw.trim()) continue;
        const r = parseLine(raw, s.subjects, s.examMax);
        if (!r) continue;
        if (r.error) { failed.push({ line: raw.trim(), reason: r.error }); continue; }
        const k = normName(r.name);
        const ex = map.get(k);
        if (ex) { ex.n = r.name; ex.g = { ...ex.g, ...r.grades }; updated++; }
        else {
          const st = { id: randHex(4), n: r.name, k, g: r.grades };
          students.push(st); map.set(k, st); added++;
        }
      }
      await putStudents(env, students);
      return json({ added, updated, failed, total: students.length });
    }

    if (path === '/api/admin/students/clear' && method === 'POST') {
      await putStudents(env, []);
      return json({ ok: true });
    }

    const mm = path.match(/^\/api\/admin\/students\/([a-f0-9]+)$/);
    if (mm) {
      const students = await getStudents(env);
      const i = students.findIndex(x => x.id === mm[1]);
      if (i < 0) return json({ error: 'غير موجود' }, 404);
      if (method === 'DELETE') {
        students.splice(i, 1);
        await putStudents(env, students);
        return json({ ok: true });
      }
      if (method === 'PUT') {
        const b = await body(request);
        const s = await getSettings(env);
        const name = clean(b.name, 120).replace(/\s+/g, ' ').trim();
        const k = normName(name);
        if (k.split(' ').length < 3 || /\d/.test(name)) return json({ error: 'الاسم يجب أن يكون ثلاثياً على الأقل' }, 400);
        if (students.some((x, j) => j !== i && x.k === k)) return json({ error: 'يوجد طالب بنفس الاسم' }, 409);
        const g = {};
        for (const sub of s.subjects) {
          const v = clean(b.g && b.g[sub.id], 10).trim();
          if (v !== '') g[sub.id] = v;
        }
        students[i] = { ...students[i], n: name, k, g };
        await putStudents(env, students);
        return json({ student: { id: students[i].id, n: name, g } });
      }
    }
    return json({ error: 'not_found' }, 404);
  }

  return new Response('Not found', { status: 404 });
}

/* ===================================================================
   واجهة الموقع
   (لا تستخدم علامة ` ولا ${ داخل هذا القسم)
   =================================================================== */
const HTML = String.raw`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>منصة إعلان النتائج</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--primary:#3b82f6;--bg:#f4f6fb;--card:#ffffff;--text:#333333;--muted:#888888;--fail:#e53935;--btn2:#4caf50}
html{font-size:clamp(9px,1.8vw,16px)}
*{box-sizing:border-box}
body{margin:0;font-family:'Cairo',Tahoma,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.wrap{max-width:55.7rem;margin:0 auto;padding:1.75rem 1.7rem 3rem}
body.hasbar .wrap{padding-top:calc(1.75rem + 42px)}
.card{background:var(--card);border-radius:.9rem;box-shadow:0 .5rem 1.9rem rgba(0,0,0,.10);padding:1.5rem 1.45rem 1.4rem;margin-bottom:1.4rem}
.hidden{display:none!important}
button{font-family:inherit;font-size:1rem;border:0;border-radius:.5rem;padding:0 1.7rem;height:3.25rem;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.b-print{background:var(--btn2)}.b-back{background:var(--primary)}.b-gray{background:#6b7280}.b-red{background:#e53935}

/* ===== شريط لوحة التحكم ===== */
.bar{position:fixed;top:0;left:0;right:0;height:42px;background:#111827;display:flex;align-items:center;justify-content:center;z-index:50}
.bar button{height:30px;padding:0 18px;font-size:14px;background:var(--primary)}

/* ===== صفحة البحث ===== */
.sc{max-width:560px;margin:0 auto;font-size:16px}
.scard{background:var(--card);border-radius:26px;box-shadow:0 14px 40px rgba(0,0,0,.12);padding:34px 36px 40px;margin-top:20px}
.slogo{width:128px;height:128px;border-radius:50%;overflow:hidden;margin:0 auto 26px}
.slogo img{width:100%;height:100%;object-fit:cover;display:block}
.s1{text-align:center;font-size:38px;font-weight:700;margin:0 0 20px;color:#111}
.s2{text-align:center;font-size:21px;font-weight:700;margin:0 0 14px;color:#222;line-height:1.5}
.s3{text-align:center;font-size:19px;margin:0 0 34px;color:#222}
.sl{display:block;font-weight:700;font-size:19px;margin-bottom:10px;color:#444}
.sin{width:100%;font-family:inherit;font-size:18px;padding:16px 18px;border:1px solid #cfd3da;border-radius:10px;background:#fff;color:#222;outline:0}
.sin:focus{border-color:var(--primary)}
.serr{color:var(--fail);font-size:15px;margin-top:12px;text-align:center;line-height:1.7}
.sbox{border:1px solid #e3e6eb;border-radius:12px;padding:20px 16px;margin:34px auto 0;max-width:420px;cursor:pointer;user-select:none;background:#fff}
.sbox img{display:block;margin:0 auto 16px;max-height:96px;max-width:85%;object-fit:contain}
.sbtn{display:flex;align-items:center;justify-content:center;gap:14px;font-weight:700;font-size:21px;color:#777}
.chk{width:32px;height:32px;border:2px solid #c7cbd3;border-radius:9px;flex-shrink:0;background:#fff}
.chk.spin{border-radius:50%;border:4px solid #e3e6eb;border-top-color:var(--primary);animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}


/* ===== النص المتحرك فوق زر إظهار النتيجة ===== */
.fx{position:relative;display:flex;justify-content:center;flex-wrap:wrap;gap:0 .3em;font-size:32px;font-weight:700;line-height:1.6;margin:0 auto 14px;padding:4px 0;direction:rtl;perspective:700px;overflow:visible}
.fx .w{display:inline-block;position:relative;animation:fxin .95s cubic-bezier(.2,.9,.3,1.25) calc(var(--i)*.15s) backwards,flt 3.2s ease-in-out calc(var(--i)*.15s + .95s) infinite alternate}
.fx .wi{display:inline-block;position:relative;transition:transform .18s ease-out;transform:translateY(var(--ty,0)) scale(var(--sc,1)) rotate(var(--rt,0deg));will-change:transform}
@keyframes fxin{from{opacity:0;transform:translateY(34px) rotateX(-80deg) scale(.6);filter:blur(10px)}to{opacity:1;transform:none;filter:blur(0)}}
@keyframes flt{from{transform:translateY(0)}to{transform:translateY(-7px)}}
@keyframes flow{to{background-position:300% 0}}
@keyframes sweep{0%{transform:translateX(-160%) skewX(-20deg)}55%,100%{transform:translateX(260%) skewX(-20deg)}}
@keyframes twk{0%,100%{opacity:0;transform:scale(.2)}50%{opacity:1;transform:scale(1)}}
@keyframes pop{0%{transform:scale(1)}40%{transform:scale(1.35) rotate(-4deg)}100%{transform:scale(1)}}
.fx.pop .w{animation:pop .5s ease calc(var(--i)*.06s),flt 3.2s ease-in-out calc(var(--i)*.15s + .5s) infinite alternate}
.fx::after{content:"";position:absolute;top:0;bottom:0;left:0;width:30%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.75),transparent);mix-blend-mode:overlay;animation:sweep 4.5s ease-in-out 1.2s infinite;pointer-events:none}
.fx .sp{position:absolute;width:8px;height:8px;border-radius:50%;background:var(--primary);box-shadow:0 0 10px 3px var(--primary);animation:twk 2.4s ease-in-out infinite;pointer-events:none}
.fx-wave .wi{background:linear-gradient(90deg,var(--primary),#8b5cf6,#ec4899,#f59e0b,var(--primary));background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:flow 5s linear infinite}
.fx-wave{filter:drop-shadow(0 4px 12px rgba(139,92,246,.35))}
.fx-neon .wi{color:#fff;text-shadow:0 0 4px #fff,0 0 12px var(--primary),0 0 26px var(--primary),0 0 48px var(--primary);animation:nflk 3.4s ease-in-out infinite}
.fx-neon{background:#0b1020;border-radius:14px;padding:14px 10px;margin-bottom:16px}
@keyframes nflk{0%,100%{opacity:1}46%{opacity:1}48%{opacity:.55}50%{opacity:1}53%{opacity:.7}55%{opacity:1}}
.fx-glitch .wi{color:var(--text)}
.fx-glitch .wi::before,.fx-glitch .wi::after{content:attr(data-text);position:absolute;left:0;top:0;width:100%;overflow:hidden}
.fx-glitch .wi::before{color:#ff2d75;transform:translateX(-2px);clip-path:inset(0 0 55% 0);animation:gl1 2.2s steps(1) infinite}
.fx-glitch .wi::after{color:#22d3ee;transform:translateX(2px);clip-path:inset(55% 0 0 0);animation:gl2 2.6s steps(1) infinite}
@keyframes gl1{0%,86%,100%{clip-path:inset(0 0 100% 0)}88%{clip-path:inset(10% 0 55% 0);transform:translateX(-4px)}92%{clip-path:inset(60% 0 10% 0);transform:translateX(3px)}96%{clip-path:inset(30% 0 40% 0);transform:translateX(-2px)}}
@keyframes gl2{0%,80%,100%{clip-path:inset(100% 0 0 0)}83%{clip-path:inset(50% 0 20% 0);transform:translateX(4px)}90%{clip-path:inset(5% 0 70% 0);transform:translateX(-3px)}95%{clip-path:inset(70% 0 5% 0);transform:translateX(2px)}}
.fx-type .wi{color:var(--primary);animation:typ 6s ease-in-out calc(var(--i)*.5s) infinite}
.fx-type::before{content:"";order:99;width:3px;height:1.1em;background:var(--primary);align-self:center;animation:blk .8s steps(1) infinite}
@keyframes typ{0%{clip-path:inset(0 0 0 100%)}25%,100%{clip-path:inset(0 0 0 0)}}
@keyframes blk{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.fx *,.fx::after,.fx::before{animation:none!important}}

/* ===== صفحة النتيجة ===== */
.head{display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.head .r{text-align:right;flex:1}
.head .l{text-align:left;flex:1;font-weight:700;font-size:1.125rem;color:#444}
.head .r h1{margin:0;font-size:1.625rem;font-weight:700;line-height:1.35}
.head .r h2{margin:0;font-size:1.2rem;font-weight:600;line-height:1.35}
.logo{width:6.4rem;height:6.4rem;border-radius:50%;overflow:hidden;background:#eef1f7;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.logo img{width:100%;height:100%;object-fit:cover;display:block}
.logo span{font-size:.75rem;color:#9aa3b5;text-align:center;padding:.4rem}
.title{text-align:center;font-weight:700;font-size:1.25rem;margin:2.75rem 0 1.6rem}
hr{border:0;border-top:1px solid #222;margin:0 0 1.4rem}
.sec{text-align:center;color:var(--primary);font-size:1.6rem;font-weight:700;margin:0 0 1.6rem}
.info{font-size:1.15rem;line-height:2rem}
.info .row{display:flex;align-items:baseline;flex-wrap:wrap}
.info .lab{font-weight:700;width:9rem;flex-shrink:0}
.note{display:flex;align-items:center;justify-content:center;gap:.6rem;color:var(--muted);font-size:.85rem;margin-top:1.25rem;line-height:1.6}
.note img{width:1.15rem;height:1.15rem;object-fit:contain;flex-shrink:0}
.tcard{padding:2.5rem 1.45rem 2.8rem}
table{width:100%;border-collapse:collapse;font-size:1.05rem;table-layout:fixed}
th{background:var(--primary);color:#fff;font-weight:600;border:1px solid #d6dbe6;height:3.05rem;padding:0 .5rem}
td{text-align:center;border:1px solid #d6dbe6;height:3.05rem;padding:0 .5rem}
tbody tr:nth-child(even){background:#f9f9f9}
td.bad{color:var(--fail)}
td .of{font-size:.8em;color:var(--muted);margin-inline-start:.45rem}
.actions{display:flex;gap:1.45rem;justify-content:center;flex-wrap:wrap;margin-top:2.9rem}

/* ===== الأدمن (بكسل ثابت) ===== */
.adm{font-size:16px}
.adm button,.modal button,.sm{height:auto;padding:11px 22px;font-size:15px}
.adm .actions{margin-top:12px;gap:10px;justify-content:flex-start}
.adm h2{margin:0 0 14px;color:var(--primary);font-size:21px}
.adm .card{padding:20px;font-size:16px;margin-bottom:16px}
.admtop{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.admtop h1{margin:0;font-size:24px}
.admtop .bt{display:flex;gap:8px;flex-wrap:wrap}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tabs button{background:#e5e9f2;color:#333}
.tabs button.on{background:var(--primary);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
label.f{display:block;font-size:14px;font-weight:600;margin-bottom:4px}
.adm input[type=text],.adm input[type=number],.adm input[type=password],.modal input[type=text],.modal input[type=password],.adm textarea{width:100%;font-family:inherit;font-size:15px;padding:10px;border:1px solid #cfd6e4;border-radius:8px;background:#fff;color:#222}
.adm textarea{min-height:230px;line-height:1.9;resize:vertical}
.adm input[type=color]{width:100%;height:42px;border:1px solid #cfd6e4;border-radius:8px;padding:2px;background:#fff}
.imgrow{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.imgrow .pv{width:84px;height:84px;border:1px solid #cfd6e4;border-radius:10px;background:#f4f6fb;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:12px;color:#999}
.imgrow .pv img{max-width:100%;max-height:100%;object-fit:contain}
.imgrow .pv.round{border-radius:50%}
.imgrow .pv.round img{width:100%;height:100%;object-fit:cover}
.small{font-size:13px;color:var(--muted);line-height:1.8;margin:4px 0 10px}
.subj{display:grid;grid-template-columns:2fr 1fr auto auto auto;gap:8px;align-items:center;margin-bottom:8px}
.srow{display:grid;grid-template-columns:1.4fr 2fr auto auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid #eef0f5}
.srow .sname{font-weight:700}
.sm{padding:7px 14px!important;font-size:14px!important}
.locked{opacity:.45;pointer-events:none}
.chkl{display:flex;gap:8px;align-items:center;font-size:14px;margin:10px 0}
.ok{color:#2e7d32}.errt{color:#e53935}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px;overflow:auto;font-size:15px}
.mcard{background:#fff;border-radius:14px;padding:22px;width:100%;max-width:440px;max-height:92vh;overflow:auto}
.mcard h3{margin:0 0 14px;color:var(--primary);font-size:20px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 20px;border-radius:10px;font-size:15px;z-index:200}
@media(max-width:640px){.subj{grid-template-columns:1fr 1fr}.srow{grid-template-columns:1fr 1fr}.scard{padding:26px 20px 30px}.s1{font-size:30px}}
@media print{body{background:#fff}.actions,.bar{display:none!important}.card{box-shadow:none;border:1px solid #ddd}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<div id="bar" class="bar hidden"><button id="barBtn" data-t="panelBar"></button></div>

<div class="wrap">

<!-- ================= صفحة البحث ================= -->
<div id="viewSearch" class="sc">
  <div class="scard">
    <div class="slogo hidden" id="sLogo"></div>
    <h1 class="s1" data-t="country"></h1>
    <h2 class="s2" data-t="ministry"></h2>
    <p class="s3" data-t="subtitle"></p>
    <label class="sl" for="nameIn" data-t="searchLabel"></label>
    <input type="text" id="nameIn" class="sin" data-ph="searchPlaceholder" autocomplete="off">
    <div class="serr hidden" id="sErr"></div>
    <div class="sbox" id="goBox" role="button" tabindex="0">
      <div id="boxFx" class="fx hidden" aria-hidden="true"></div>
      <div class="sbtn"><span class="chk" id="chk"></span><span id="goTxt" data-t="searchBtn"></span></div>
    </div>
  </div>
</div>

<!-- ================= صفحة النتيجة ================= -->
<div id="viewResult" class="hidden">
  <div id="resBox"></div>
  <div class="actions">
    <button class="b-back" id="btnBack" data-t="btnBack"></button>
    <button class="b-print" id="btnPrint" data-t="btnPrint"></button>
  </div>
</div>

<!-- ================= لوحة التحكم ================= -->
<div id="viewAdmin" class="adm hidden">
  <div class="admtop">
    <h1>🎛 لوحة التحكم</h1>
    <div class="bt">
      <button class="b-red" id="btnHidePanel">إيقاف إظهار لوحة التحكم</button>
      <button class="b-gray" id="btnExit">خروج</button>
    </div>
  </div>
  <div class="tabs" id="tabs">
    <button data-tab="Add" class="on">إضافة الطلاب</button>
    <button data-tab="Subj">المواد</button>
    <button data-tab="Stud">تعديل الطلاب وإدارتهم</button>
    <button data-tab="Set">النصوص والصور</button>
  </div>

  <div id="tabAdd">
    <div class="card">
      <h2>الخطوة 1: حدد درجة الامتحان من كم؟</h2>
      <p class="small">مثال: إذا كان الامتحان من 100 اكتب 100. ستظهر بجانب درجة كل مادة للطالب (مثلاً: 40 من 50).</p>
      <div style="max-width:220px"><input type="number" id="exMax" min="1" placeholder="مثال: 100"></div>
      <label class="chkl"><input type="checkbox" id="exAll" checked> تطبيقها على كل المواد (إلغاء الدرجات المخصصة لكل مادة)</label>
      <div class="actions"><button class="b-back" id="btnExMax">حفظ والمتابعة</button></div>
    </div>
    <div class="card locked" id="step2">
      <h2>الخطوة 2: أرسل الطلاب دفعة واحدة عن طريق نص</h2>
      <p class="small" id="bulkHint"></p>
      <textarea id="bulkText" placeholder="اكتب كل طالب في سطر مستقل"></textarea>
      <div class="actions"><button class="b-print" id="btnBulk">إضافة الطلاب</button></div>
      <div id="bulkRes" style="margin-top:12px;font-size:15px;line-height:1.9"></div>
    </div>
  </div>

  <div id="tabSubj" class="hidden">
    <div class="card">
      <h2>إضافة مواد</h2>
      <p class="small">اكتب اسم المادة (أو عدة مواد، كل مادة في سطر). سيكون ترتيب المواد في النتيجة بنفس ترتيبها هنا.</p>
      <textarea id="subjNew" style="min-height:110px" placeholder="اللغة العربية&#10;الأدب"></textarea>
      <div class="actions"><button class="b-back" id="btnSubjAdd">+ إضافة</button></div>
    </div>
    <div class="card">
      <h2>المواد الحالية</h2>
      <p class="small">الخانة الثانية (من) اختيارية: اتركها فارغة لتستخدم درجة الامتحان العامة. تُحفظ التعديلات تلقائياً.</p>
      <div id="subjList"></div>
    </div>
  </div>

  <div id="tabStud" class="hidden">
    <div class="card">
      <h2>الطلاب <span class="small" id="stCount"></span></h2>
      <input type="text" id="stQ" placeholder="ابحث عن طالب بالاسم...">
      <div id="stList" style="margin-top:10px"></div>
      <div class="actions"><button class="b-red" id="btnClearAll">حذف جميع الطلاب</button></div>
    </div>
  </div>

  <div id="tabSet" class="hidden"></div>
</div>

</div>

<!-- نافذة إدخال الرمز السري -->
<div id="codeModal" class="modal hidden">
  <div class="mcard">
    <h3>الرمز السري</h3>
    <p class="small">أدخل الرمز الذي أرسله لك البوت على تيليجرام.</p>
    <input type="password" id="codeIn" placeholder="••••••••" autocomplete="off">
    <p class="errt hidden" id="codeErr" style="font-size:14px;margin:8px 0 0"></p>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="b-back" id="btnCodeOk">دخول</button>
      <button class="b-gray" id="btnCodeCancel">إلغاء</button>
    </div>
  </div>
</div>

<script>
var BOOT=/*__CFG__*/null;
var C=BOOT,TOKEN=sessionStorage.getItem('tk')||'',AD=null,ST=null,TAB='Add';
var $=function(id){return document.getElementById(id);};
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
var CHECK_SVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l8 3.2v6.1c0 4.9-3.3 8.6-8 10.2-4.7-1.6-8-5.3-8-10.2V5.7z"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>';
var TL=[['schoolName','اسم المدرسة (ثابت لكل الطلاب)'],['country','العنوان الكبير'],['ministry','العنوان تحته'],['subtitle','نص منصة إعلان النتائج'],['searchLabel','عنوان خانة الاسم'],['searchPlaceholder','النص داخل خانة الاسم'],['searchBtn','نص زر إظهار النتيجة'],['errShort','رسالة: الاسم غير مكتمل'],['errNotFound','رسالة: لا توجد نتيجة'],['errServer','رسالة: خطأ في الاتصال'],['committee','النص الأيسر في صفحة النتيجة'],['title','عنوان النتيجة'],['section','عنوان معلومات الطالب'],['tableTitle','عنوان جدول النتيجة'],['lName','تسمية الاسم'],['lSchool','تسمية المدرسة'],['note','الملاحظة أسفل البطاقة (ضع ** حول الكلمات العريضة)'],['thSubj','عمود المادة'],['thGrade','عمود الدرجة'],['ofText','كلمة (من) بجانب الدرجة'],['btnPrint','زر الطباعة'],['btnBack','زر العودة'],['panelBar','زر لوحة التحكم أعلى الموقع'],['boxText','النص المتحرك فوق زر إظهار النتيجة (اتركه فارغاً لإخفائه)']];
var CL=[['primary','اللون الأساسي'],['bg','خلفية الصفحة'],['card','خلفية البطاقات'],['text','لون النص'],['muted','لون الملاحظة'],['fail','لون الدرجات الراسبة'],['btn2','لون زر الطباعة']];

function el(tag,props,kids){
  var e=document.createElement(tag);
  if(props)for(var k in props){
    if(k==='class')e.className=props[k];
    else if(k==='text')e.textContent=props[k];
    else if(k.slice(0,2)==='on')e[k]=props[k];
    else e.setAttribute(k,props[k]);
  }
  (kids||[]).forEach(function(c){if(c==null)return;e.appendChild(typeof c==='string'?document.createTextNode(c):c);});
  return e;
}
function toast(m){var t=el('div',{class:'toast',text:m});document.body.appendChild(t);setTimeout(function(){t.remove();},2200);}
function show(v){['viewSearch','viewResult','viewAdmin'].forEach(function(x){$(x).classList.add('hidden');});$(v).classList.remove('hidden');window.scrollTo(0,0);}

async function api(path,method,body,auth){
  var o={method:method||'GET',headers:{}};
  if(body!==undefined){o.headers['content-type']='application/json';o.body=JSON.stringify(body);}
  if(auth&&TOKEN)o.headers['authorization']='Bearer '+TOKEN;
  try{
    var r=await fetch(path,o);
    var d={};try{d=await r.json();}catch(e){}
    return {ok:r.ok,status:r.status,data:d};
  }catch(e){return {ok:false,status:0,data:{error:'تعذر الاتصال بالخادم'}};}
}
function authFail(r){
  if(r.status===401){
    TOKEN='';sessionStorage.removeItem('tk');
    alert('انتهت الجلسة أو تم إيقاف لوحة التحكم');
    loadConfig().then(function(){show('viewSearch');});
    return true;
  }
  return false;
}

/* ---------- الإعدادات العامة ---------- */
async function loadConfig(){
  var r=await api('/api/config');
  if(r.ok){C=r.data;}
  else if(!C){C={s:{t:{},colors:{},logo:'',boxImage:'',noteIcon:'',examMax:0,passPercent:50},panelVisible:false};}
  applySettings();
}
function applySettings(){
  var s=C.s,t=s.t,c=s.colors,root=document.documentElement.style;
  for(var k in c)root.setProperty('--'+k,c[k]);
  document.querySelectorAll('[data-t]').forEach(function(e){var v=t[e.getAttribute('data-t')];if(v!==undefined)e.textContent=v;});
  document.querySelectorAll('[data-ph]').forEach(function(e){var v=t[e.getAttribute('data-ph')];if(v!==undefined)e.setAttribute('placeholder',v);});
  document.title=t.country||'النتائج';
  var sl=$('sLogo');
  if(s.logo){sl.innerHTML='';sl.appendChild(el('img',{src:s.logo,alt:''}));sl.classList.remove('hidden');}else sl.classList.add('hidden');
  renderFx($('boxFx'),t.boxText,t.boxStyle);
  var vis=!!C.panelVisible;
  $('bar').classList.toggle('hidden',!vis);
  document.body.classList.toggle('hasbar',vis);
}


/* ---------- النص المتحرك التفاعلي ---------- */
function renderFx(box,txt,style){
  txt=String(txt||'').trim();
  if(!txt){box.classList.add('hidden');box.innerHTML='';box._k='';return;}
  style=['wave','neon','glitch','type'].indexOf(style)>=0?style:'wave';
  var key=txt+'|'+style;
  box.classList.remove('hidden');
  if(box._k===key)return;
  box._k=key;box.innerHTML='';box.className='fx fx-'+style;
  txt.split(/\s+/).forEach(function(w,i){
    var wi=el('span',{class:'wi','data-text':w,text:w});
    var o=el('span',{class:'w'},[wi]);o.style.setProperty('--i',i);box.appendChild(o);
  });
  for(var k=0;k<5;k++){
    var sp=el('span',{class:'sp'});
    sp.style.left=(8+Math.random()*84)+'%';sp.style.top=(Math.random()*90)+'%';
    sp.style.animationDelay=(Math.random()*2.4)+'s';sp.style.width=sp.style.height=(4+Math.random()*6)+'px';
    box.appendChild(sp);
  }
  if(!box._ev){
    box._ev=true;
    var move=function(e){
      var x=e.clientX,ws=box.querySelectorAll('.w');
      for(var j=0;j<ws.length;j++){
        var r=ws[j].getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
        var dx=(x-cx)/Math.max(r.width,60),dy=(e.clientY-cy)/60;
        var f=Math.exp(-(dx*dx+dy*dy)*1.2),wi=ws[j].firstChild;
        wi.style.setProperty('--sc',(1+0.32*f).toFixed(3));
        wi.style.setProperty('--ty',(-9*f).toFixed(1)+'px');
        wi.style.setProperty('--rt',(dx*-6*f).toFixed(1)+'deg');
      }
    };
    var reset=function(){box.querySelectorAll('.wi').forEach(function(wi){wi.style.setProperty('--sc',1);wi.style.setProperty('--ty','0px');wi.style.setProperty('--rt','0deg');});};
    box.addEventListener('pointermove',move);
    box.addEventListener('pointerleave',reset);
    box.addEventListener('pointerdown',function(e){move(e);box.classList.remove('pop');void box.offsetWidth;box.classList.add('pop');setTimeout(function(){box.classList.remove('pop');},900);});
  }
}

/* ---------- البحث وعرض النتيجة ---------- */
var busy=false;
function setLoading(on){busy=on;$('chk').classList.toggle('spin',on);}
function showErr(m){var e=$('sErr');e.textContent=m;e.classList.remove('hidden');}
async function doSearch(){
  if(busy)return;
  var t=C.s.t;$('sErr').classList.add('hidden');
  var name=$('nameIn').value.trim().replace(/\s+/g,' ');
  if(name.split(' ').length<3){showErr(t.errShort||'');return;}
  setLoading(true);var t0=Date.now();
  var r=await api('/api/search','POST',{name:name});
  var w=900-(Date.now()-t0);if(w>0)await sleep(w);
  setLoading(false);
  if(r.ok){renderResults(r.data.results);show('viewResult');}
  else if(r.status===404)showErr(t.errNotFound||'');
  else if(r.status===400)showErr(t.errShort||'');
  else showErr(t.errServer||'');
}
function noteNode(){
  var t=C.s.t,n=el('div',{class:'note'});
  if(C.s.noteIcon)n.appendChild(el('img',{src:C.s.noteIcon,alt:''}));
  else{var sp=el('span',{style:'display:flex;flex-shrink:0'});sp.innerHTML=CHECK_SVG;n.appendChild(sp);}
  var tx=el('span');
  String(t.note||'').split('**').forEach(function(p,i){
    if(!p)return;
    if(i%2){var b=el('strong',{text:p});b.style.color='#666';tx.appendChild(b);}
    else tx.appendChild(document.createTextNode(p));
  });
  n.appendChild(tx);return n;
}
function buildResult(r){
  var t=C.s.t,f=document.createDocumentFragment();
  var c1=el('div',{class:'card'});
  var logo=C.s.logo?el('div',{class:'logo'},[el('img',{src:C.s.logo,alt:''})]):el('div',{class:'logo',style:'visibility:hidden'});
  c1.appendChild(el('div',{class:'head'},[
    el('div',{class:'r'},[el('h1',{text:t.country}),el('h2',{text:t.ministry})]),
    logo,el('div',{class:'l',text:t.committee})]));
  c1.appendChild(el('div',{class:'title',text:t.title}));
  c1.appendChild(el('hr'));
  c1.appendChild(el('div',{class:'sec',text:t.section}));
  var info=el('div',{class:'info'});
  info.appendChild(el('div',{class:'row'},[el('span',{class:'lab',text:t.lName}),el('span',{text:r.name})]));
  if(t.schoolName)info.appendChild(el('div',{class:'row'},[el('span',{class:'lab',text:t.lSchool}),el('span',{text:t.schoolName})]));
  c1.appendChild(info);c1.appendChild(noteNode());f.appendChild(c1);
  var c2=el('div',{class:'card tcard'});
  c2.appendChild(el('div',{class:'sec',text:t.tableTitle}));
  var body=el('tbody');
  r.rows.forEach(function(x){
    var td=el('td',{class:x.bad?'bad':''},[String(x.g)]);
    if(x.max)td.appendChild(el('span',{class:'of',text:(t.ofText||'')+' '+x.max}));
    body.appendChild(el('tr',null,[el('td',{text:x.n}),td]));
  });
  c2.appendChild(el('table',null,[el('thead',null,[el('tr',null,[el('th',{text:t.thSubj}),el('th',{text:t.thGrade})])]),body]));
  f.appendChild(c2);return f;
}
function renderResults(list){var b=$('resBox');b.innerHTML='';list.forEach(function(r){b.appendChild(buildResult(r));});}

$('goBox').onclick=doSearch;
$('goBox').onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();doSearch();}};
$('nameIn').onkeydown=function(e){if(e.key==='Enter')doSearch();};
$('btnPrint').onclick=function(){window.print();};
$('btnBack').onclick=function(){$('nameIn').value='';$('sErr').classList.add('hidden');$('resBox').innerHTML='';show('viewSearch');};

/* ---------- دخول لوحة التحكم ---------- */
$('barBtn').onclick=async function(){
  if(TOKEN){var ok=await loadAdmin(true);if(ok)return;}
  $('codeIn').value='';$('codeErr').classList.add('hidden');$('codeModal').classList.remove('hidden');$('codeIn').focus();
};
$('btnCodeCancel').onclick=function(){$('codeModal').classList.add('hidden');};
$('codeIn').onkeydown=function(e){if(e.key==='Enter')$('btnCodeOk').click();};
$('btnCodeOk').onclick=async function(){
  var code=$('codeIn').value.trim();if(!code)return;
  var r=await api('/api/admin/login','POST',{code:code});
  if(r.ok){TOKEN=r.data.token;sessionStorage.setItem('tk',TOKEN);$('codeModal').classList.add('hidden');await loadAdmin(false);}
  else{
    var e=$('codeErr');e.textContent=r.status===429?'محاولات كثيرة، حاول لاحقاً':(r.status===401?'الرمز غير صحيح':'حدث خطأ');e.classList.remove('hidden');
  }
};
async function loadAdmin(silent){
  var r=await api('/api/admin/data','GET',undefined,true);
  if(r.status===401){TOKEN='';sessionStorage.removeItem('tk');return false;}
  if(!r.ok){if(!silent)alert('تعذر تحميل البيانات');return false;}
  AD=r.data;C.s=Object.assign({},AD.settings);delete C.s.subjects;applySettings();
  show('viewAdmin');setTab(TAB);return true;
}
$('btnExit').onclick=async function(){await loadConfig();show('viewSearch');};
$('btnHidePanel').onclick=async function(){
  if(!confirm('سيتم إخفاء لوحة التحكم من الموقع وإلغاء الرمز السري. متابعة؟'))return;
  var r=await api('/api/admin/hide','POST',{},true);
  if(authFail(r))return;
  TOKEN='';sessionStorage.removeItem('tk');await loadConfig();show('viewSearch');toast('تم إيقاف إظهار لوحة التحكم');
};

/* ---------- التبويبات ---------- */
document.querySelectorAll('#tabs button').forEach(function(b){b.onclick=function(){setTab(b.getAttribute('data-tab'));};});
async function setTab(t){
  TAB=t;
  document.querySelectorAll('#tabs button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tab')===t);});
  ['Add','Subj','Stud','Set'].forEach(function(x){$('tab'+x).classList.toggle('hidden',x!==t);});
  if(t==='Stud'||t==='Add'){var r=await api('/api/admin/data','GET',undefined,true);if(authFail(r))return;if(r.ok)AD=r.data;}
  if(t==='Add')renderAdd();
  if(t==='Subj')renderSubj();
  if(t==='Stud')renderStud();
  if(t==='Set')renderSet();
}

/* ---------- إضافة الطلاب ---------- */
function renderAdd(){
  var s=AD.settings;
  $('exMax').value=s.examMax||'';
  $('step2').classList.toggle('locked',!s.examMax);
  var h=$('bulkHint');
  if(!s.subjects.length){h.textContent='⚠️ لا توجد مواد بعد. أضف المواد أولاً من نافذة «المواد».';return;}
  var ex='علي سعيد علي';
  s.subjects.slice(0,3).forEach(function(x,i){ex+=' '+x.name+' '+[40,30,25][i];});
  h.textContent='اكتب اسم الطالب الثلاثي ثم اسم كل مادة ودرجتها، وكل طالب في سطر مستقل (اسم تحت اسم). مثال: '+ex+' — للغياب اكتب غ. المواد: '+s.subjects.map(function(x){return x.name;}).join('، ');
}
$('btnExMax').onclick=async function(){
  var n=Number($('exMax').value);
  if(!(n>0)){alert('اكتب درجة الامتحان رقماً أكبر من صفر');return;}
  var r=await api('/api/admin/settings','PUT',{examMax:n},true);if(authFail(r))return;
  if(r.ok){
    AD.settings=r.data.settings;
    if($('exAll').checked&&AD.settings.subjects.some(function(x){return x.max;})){
      var subs=AD.settings.subjects.map(function(x){return {id:x.id,name:x.name,max:null};});
      var r2=await api('/api/admin/subjects','PUT',{subjects:subs},true);if(authFail(r2))return;
      if(r2.ok)AD.settings.subjects=r2.data.subjects;
    }
    C.s.examMax=n;renderAdd();toast('تم حفظ درجة الامتحان: '+n);
  }
};
$('btnBulk').onclick=async function(){
  var text=$('bulkText').value;if(!text.trim()){alert('اكتب الطلاب أولاً');return;}
  var btn=$('btnBulk');btn.disabled=true;
  var r=await api('/api/admin/students/bulk','POST',{text:text},true);btn.disabled=false;
  if(authFail(r))return;
  var box=$('bulkRes');box.innerHTML='';
  if(!r.ok){box.appendChild(el('div',{class:'errt',text:r.data.error||'حدث خطأ'}));return;}
  var d=r.data;
  box.appendChild(el('div',{class:'ok',text:'✅ تمت إضافة '+d.added+' طالب، وتحديث '+d.updated+' طالب. (الإجمالي: '+d.total+')'}));
  if(d.failed.length){
    box.appendChild(el('div',{class:'errt',text:'⚠️ '+d.failed.length+' سطر لم يُضف:'}));
    d.failed.forEach(function(f){box.appendChild(el('div',{class:'errt small',text:f.line+'  ←  '+f.reason}));});
    $('bulkText').value=d.failed.map(function(f){return f.line;}).join('\n');
  }else $('bulkText').value='';
};

/* ---------- المواد ---------- */
function renderSubj(){
  var box=$('subjList');box.innerHTML='';
  var arr=AD.settings.subjects;
  if(!arr.length)box.appendChild(el('p',{class:'small',text:'لا توجد مواد بعد.'}));
  arr.forEach(function(s,i){
    var n=el('input',{type:'text',placeholder:'اسم المادة'});n.value=s.name;
    var m=el('input',{type:'number',placeholder:'من (اختياري)'});m.value=s.max||'';
    n.onchange=function(){s.name=n.value.trim();saveSubj();};
    m.onchange=function(){s.max=m.value?Number(m.value):null;saveSubj();};
    var up=el('button',{class:'b-gray sm',text:'↑',onclick:function(){if(i>0){arr.splice(i-1,0,arr.splice(i,1)[0]);saveSubj(true);}}});
    var dn=el('button',{class:'b-gray sm',text:'↓',onclick:function(){if(i<arr.length-1){arr.splice(i+1,0,arr.splice(i,1)[0]);saveSubj(true);}}});
    var del=el('button',{class:'b-red sm',text:'حذف',onclick:function(){
      if(!confirm('سيتم حذف المادة ودرجاتها لدى جميع الطلاب. متابعة؟'))return;
      arr.splice(i,1);saveSubj(true);}});
    box.appendChild(el('div',{class:'subj'},[n,m,up,dn,del]));
  });
}
async function saveSubj(rerender){
  var r=await api('/api/admin/subjects','PUT',{subjects:AD.settings.subjects},true);if(authFail(r))return;
  if(r.ok){AD.settings.subjects=r.data.subjects;if(rerender)renderSubj();toast('تم الحفظ');}
}
$('btnSubjAdd').onclick=function(){
  var names=$('subjNew').value.split(/[\n,،]+/).map(function(x){return x.trim();}).filter(Boolean);
  if(!names.length)return;
  names.forEach(function(n){AD.settings.subjects.push({name:n,max:null});});
  $('subjNew').value='';saveSubj(true);
};

/* ---------- إدارة الطلاب ---------- */
function foldC(s){return s.replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').toLowerCase();}
function renderStud(){
  var q=foldC($('stQ').value.trim()),box=$('stList');box.innerHTML='';
  var subs=AD.settings.subjects;
  var list=AD.students.filter(function(s){return !q||foldC(s.n).indexOf(q)>=0;});
  $('stCount').textContent='(العدد: '+AD.students.length+')';
  if(!list.length)box.appendChild(el('p',{class:'small',text:'لا توجد نتائج.'}));
  list.slice(0,150).forEach(function(s){
    var sum=subs.map(function(sb){return s.g[sb.id]!==undefined?sb.name+': '+s.g[sb.id]:null;}).filter(Boolean).join(' | ');
    box.appendChild(el('div',{class:'srow'},[
      el('div',{class:'sname',text:s.n}),el('div',{class:'small',style:'margin:0',text:sum}),
      el('button',{class:'b-back sm',text:'تعديل',onclick:function(){editStudent(s);}}),
      el('button',{class:'b-red sm',text:'حذف',onclick:async function(){
        if(!confirm('حذف الطالب '+s.n+'؟'))return;
        var r=await api('/api/admin/students/'+s.id,'DELETE',undefined,true);if(authFail(r))return;
        if(r.ok){AD.students=AD.students.filter(function(x){return x.id!==s.id;});renderStud();}}})]));
  });
  if(list.length>150)box.appendChild(el('p',{class:'small',text:'يظهر أول 150 فقط، استخدم البحث للوصول لبقية الطلاب.'}));
}
$('stQ').oninput=renderStud;
$('btnClearAll').onclick=async function(){
  if(!confirm('سيتم حذف جميع الطلاب نهائياً. متابعة؟'))return;
  if(!confirm('تأكيد أخير: حذف كل الطلاب؟'))return;
  var r=await api('/api/admin/students/clear','POST',{},true);if(authFail(r))return;
  if(r.ok){AD.students=[];renderStud();toast('تم الحذف');}
};
function editStudent(s){
  var subs=AD.settings.subjects;
  var name=el('input',{type:'text'});name.value=s.n;
  var inputs={};
  var card=el('div',{class:'mcard'},[el('h3',{text:'تعديل الطالب'}),el('label',{class:'f',text:'الاسم الثلاثي'}),name]);
  subs.forEach(function(sb){
    var i=el('input',{type:'text'});i.value=s.g[sb.id]!==undefined?s.g[sb.id]:'';inputs[sb.id]=i;
    card.appendChild(el('label',{class:'f',style:'margin-top:10px',text:sb.name}));card.appendChild(i);
  });
  var modal=el('div',{class:'modal'},[card]);
  var err=el('p',{class:'errt hidden',style:'font-size:14px'});card.appendChild(err);
  card.appendChild(el('div',{style:'display:flex;gap:8px;margin-top:14px'},[
    el('button',{class:'b-print',text:'حفظ',onclick:async function(){
      var g={};for(var id in inputs)g[id]=inputs[id].value;
      var r=await api('/api/admin/students/'+s.id,'PUT',{name:name.value,g:g},true);if(authFail(r))return;
      if(r.ok){s.n=r.data.student.n;s.g=r.data.student.g;modal.remove();renderStud();toast('تم الحفظ');}
      else{err.textContent=r.data.error||'حدث خطأ';err.classList.remove('hidden');}}}),
    el('button',{class:'b-gray',text:'إلغاء',onclick:function(){modal.remove();}})]));
  document.body.appendChild(modal);
}

/* ---------- النصوص والصور والألوان ---------- */
function readImage(file,mode,cb){
  var rd=new FileReader();
  rd.onload=function(){
    var img=new Image();
    img.onload=function(){
      var c=document.createElement('canvas'),x=c.getContext('2d');
      if(mode==='logo'){
        var m=Math.min(img.width,img.height),size=360;c.width=c.height=size;
        x.fillStyle='#fff';x.fillRect(0,0,size,size);
        x.drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,size,size);
        cb(c.toDataURL('image/jpeg',0.9));
      }else{
        var max=mode==='box'?520:160,k=Math.min(1,max/Math.max(img.width,img.height));
        c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
        x.drawImage(img,0,0,c.width,c.height);cb(c.toDataURL('image/png'));
      }
    };
    img.src=rd.result;
  };
  rd.readAsDataURL(file);
}
async function saveSettings(msg){
  var p={t:ST.t,colors:ST.colors,logo:ST.logo,boxImage:ST.boxImage,noteIcon:ST.noteIcon,passPercent:ST.passPercent};
  var r=await api('/api/admin/settings','PUT',p,true);if(authFail(r))return;
  if(r.ok){AD.settings=r.data.settings;C.s=Object.assign({},r.data.settings);delete C.s.subjects;applySettings();toast(msg||'تم الحفظ');}
  else alert(r.data.error||'تعذر الحفظ (قد تكون الصورة كبيرة)');
}
function imgCard(title,key,mode,hint,round){
  var pv=el('div',{class:'pv'+(round?' round':'')});
  function upd(){pv.innerHTML='';if(ST[key])pv.appendChild(el('img',{src:ST[key],alt:''}));else pv.textContent='لا توجد';}
  upd();
  var file=el('input',{type:'file',accept:'image/*'});
  file.onchange=function(){var f=file.files[0];if(!f)return;readImage(f,mode,function(d){ST[key]=d;upd();saveSettings('تم حفظ الصورة');});};
  var del=el('button',{class:'b-red sm',text:'حذف الصورة',onclick:function(){ST[key]='';upd();saveSettings('تم حذف الصورة');}});
  return el('div',{class:'card'},[el('h2',{text:title}),el('div',{class:'imgrow'},[pv,el('div',null,[file,el('p',{class:'small',text:hint}),del])])]);
}
function renderSet(){
  var s=AD.settings,box=$('tabSet');box.innerHTML='';
  ST={t:Object.assign({},s.t),colors:Object.assign({},s.colors),logo:s.logo,boxImage:s.boxImage,noteIcon:s.noteIcon,passPercent:s.passPercent};
  box.appendChild(imgCard('الصورة الدائرية (الشعار)','logo','logo','تظهر دائرية أعلى صفحة البحث وفي رأس صفحة النتيجة.',true));
  box.appendChild(imgCard('أيقونة الملاحظة','noteIcon','icon','إن لم ترفع صورة تظهر علامة الصح الافتراضية.',false));
  var g=el('div',{class:'grid'});
  TL.forEach(function(p){
    var i=el('input',{type:'text'});i.value=ST.t[p[0]]||'';i.oninput=function(){ST.t[p[0]]=i.value;};
    g.appendChild(el('div',null,[el('label',{class:'f',text:p[1]}),i]));
  });
  var pvBox=el('div',{class:'fx'});pvBox.style.margin='10px auto';
  var sel=el('select',{style:'font-family:inherit;font-size:15px;padding:10px;border:1px solid #cfd6e4;border-radius:8px;width:100%;max-width:280px'});
  [['wave','موجة متدرجة الألوان'],['neon','نيون متوهج'],['glitch','تشويش رقمي (Glitch)'],['type','كتابة تلقائية']].forEach(function(o){
    var op=el('option',{value:o[0],text:o[1]});if(ST.t.boxStyle===o[0])op.selected=true;sel.appendChild(op);
  });
  function upFx(){renderFx(pvBox,ST.t.boxText,ST.t.boxStyle);}
  sel.onchange=function(){ST.t.boxStyle=sel.value;upFx();};
  g.querySelectorAll('input').forEach(function(inp,idx){if(TL[idx][0]==='boxText'){inp.addEventListener('input',upFx);}});
  box.appendChild(el('div',{class:'card'},[el('h2',{text:'النص المتحرك فوق زر إظهار النتيجة'}),
    el('p',{class:'small',text:'غيّر النص من خانة «النص المتحرك» في قسم النصوص أسفله، واختر الشكل هنا. حرّك الماوس أو الإصبع فوقه وسيتفاعل معك. ثم اضغط حفظ.'}),
    sel,pvBox]));
  upFx();
  box.appendChild(el('div',{class:'card'},[el('h2',{text:'النصوص'}),g]));
  var pp=el('input',{type:'number',min:'0',max:'100'});pp.value=ST.passPercent;pp.oninput=function(){ST.passPercent=Number(pp.value)||0;};
  box.appendChild(el('div',{class:'card'},[el('h2',{text:'درجة النجاح'}),
    el('p',{class:'small',text:'تظهر الدرجة بالأحمر إذا كانت أقل من هذه النسبة من درجة الامتحان (أو كانت غياب «غ»). اكتب 0 لإلغاء التلوين.'}),
    el('div',{style:'max-width:220px'},[el('label',{class:'f',text:'نسبة النجاح %'}),pp])]));
  var cg=el('div',{class:'grid'});
  CL.forEach(function(p){
    var i=el('input',{type:'color'});i.value=ST.colors[p[0]];
    i.oninput=function(){ST.colors[p[0]]=i.value;document.documentElement.style.setProperty('--'+p[0],i.value);};
    cg.appendChild(el('div',null,[el('label',{class:'f',text:p[1]}),i]));
  });
  box.appendChild(el('div',{class:'card'},[el('h2',{text:'الألوان'}),cg]));
  box.appendChild(el('div',{class:'actions'},[el('button',{class:'b-print',text:'حفظ النصوص والألوان',onclick:function(){saveSettings();}})]));
}

/* ---------- البداية ---------- */
(async function(){
  try{
    if(C){applySettings();if(C.kvError)showErr('تعذر الاتصال بقاعدة التخزين (KV). تأكد من ربط DB في إعدادات الـ Worker.');}
    await loadConfig();
  }catch(e){}
  show('viewSearch');
})();
</script>
</body>
</html>`;
