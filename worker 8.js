/* =====================================================================
   موقع نتائج الطلاب + لوحة تحكم + بوت تيليجرام  (Cloudflare Worker)
   التخزين: KV باسم DB
   الأسرار: BOT_TOKEN , WEBHOOK_SECRET      المتغيرات: ADMIN_IDS
   الدخول للوحة التحكم: عن طريق رابط خاص يرسله البوت (بدون رمز سري)
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
  errNeedFull: 'يوجد اسم مشابه لاسمك، يرجى كتابة اسمك الرباعي كاملاً.',
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
  boxStyle: 'wave',
  postText: 'اضغط الزر أدناه لمعرفة نتيجتك',
  postBtn: 'إظهار النتيجة'
};
const DEFAULT_COLORS = {
  primary: '#3b82f6', bg: '#f4f6fb', card: '#ffffff', text: '#333333',
  muted: '#888888', fail: '#e53935', btn2: '#4caf50'
};
const DEFAULT_SETTINGS = {
  t: DEFAULT_T, colors: DEFAULT_COLORS,
  logo: '', boxImage: '', noteIcon: '',
  examMax: 0, passPercent: 50, subjects: [], sections: []
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
function clean(s, max) { return String(s == null ? '' : s).slice(0, max); }

/* ------------------------------ التخزين ------------------------------ */
async function getSettings(env) {
  const s = (await env.DB.get('settings', 'json')) || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    t: { ...DEFAULT_T, ...(s.t || {}) },
    colors: { ...DEFAULT_COLORS, ...(s.colors || {}) },
    subjects: Array.isArray(s.subjects) ? s.subjects : [],
    sections: Array.isArray(s.sections) ? s.sections : []
  };
}
async function putSettings(env, s) { await env.DB.put('settings', JSON.stringify(s)); }
async function getStudents(env) { return (await env.DB.get('students', 'json')) || []; }
async function putStudents(env, a) { await env.DB.put('students', JSON.stringify(a)); }
async function getState(env) {
  const st = (await env.DB.get('state', 'json')) || {};
  return { epoch: Number(st.epoch) || 1 };
}
async function putState(env, st) { await env.DB.put('state', JSON.stringify(st)); }

function publicSettings(s) { const { subjects, sections, ...rest } = s; return rest; }

/* ------------------------------ تيليجرام: التحقق والقناة ------------------------------ */
const ENC = new TextEncoder();
async function hmacRaw(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
function toHex(u8) { return [...u8].map(x => x.toString(16).padStart(2, '0')).join(''); }

// التحقق من بيانات تطبيق تيليجرام المصغّر (initData): لا يمكن تزويرها بدون توكن البوت
async function verifyInit(env, init) {
  try {
    init = String(init || '');
    if (init.length < 20 || init.length > 4000) return null;
    const p = new URLSearchParams(init);
    const hash = p.get('hash') || '';
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    p.delete('hash');
    const ent = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));
    const dcs = ent.map(e => e[0] + '=' + e[1]).join('\n');
    const secret = await hmacRaw(ENC.encode('WebAppData'), ENC.encode(String(env.BOT_TOKEN || '')));
    const calc = toHex(await hmacRaw(secret, ENC.encode(dcs)));
    if (!safeEq(calc, hash)) return null;
    const ad = Number(p.get('auth_date'));
    if (!ad || Date.now() / 1000 - ad > 86400) return null;
    const user = JSON.parse(p.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch (e) { return null; }
}
async function tgj(env, method, body) {
  try { const r = await tg(env, method, body); return await r.json(); }
  catch (e) { return { ok: false, description: 'network' }; }
}
async function getChan(env) { return await env.DB.get('chan', 'json'); }
async function getAppLink(env) {
  const v = await env.DB.get('applink');
  return v || String(env.APP_LINK || '').slice(0, 200);
}
function botId(env) { return String(env.BOT_TOKEN || '').split(':')[0]; }
function chanInfo(chan) {
  if (!chan) return null;
  return { title: chan.title, url: chan.username ? 'https://t.me/' + chan.username : '' };
}
async function checkMember(env, chan, uid) {
  const r = await tgj(env, 'getChatMember', { chat_id: chan.id, user_id: uid });
  if (!r.ok) return { err: r.description || 'error' };
  const m = r.result || {};
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return { member: true };
  if (m.status === 'restricted' && m.is_member) return { member: true };
  return { member: false };
}
/*
  حالات الطالب:  badinit | nochannel | chanerror | notmember | done | ready
  done  = استُخدمت المحاولة الوحيدة (من هذا الحساب أو من هذا الجهاز)
*/
async function tgGate(env, b) {
  const user = await verifyInit(env, b.init);
  if (!user) return { state: 'badinit' };
  const admin = isAdminId(env, user.id);
  const chan = await getChan(env);
  if (!chan) return { state: 'nochannel', user, admin };
  const m = await checkMember(env, chan, user.id);
  if (m.err) return { state: 'chanerror', user, admin, chan };
  if (!m.member) return { state: 'notmember', user, admin, chan };
  if (admin) return { state: 'ready', user, admin, chan, dev: '' };
  const devs = [];
  for (const x of [].concat(Array.isArray(b.devs) ? b.devs : [], [b.dev])) {
    const v = String(x || '');
    if (/^[a-f0-9]{24}$/.test(v) && !devs.includes(v)) devs.push(v);
    if (devs.length >= 4) break;
  }
  const [u, ...ds] = await Promise.all([env.DB.get('u:' + user.id), ...devs.map(x => env.DB.get('d:' + x))]);
  if (u !== null || ds.some(x => x !== null)) return { state: 'done', user, admin, chan, devs };
  return { state: 'ready', user, admin, chan, devs };
}

/* ------------------------------ المصادقة ------------------------------ */
function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  return /^[a-f0-9]{48}$/.test(tok) ? tok : '';
}
async function isAuthed(request, env) {
  const tok = bearer(request);
  if (!tok) return false;
  const [st, ep] = await Promise.all([getState(env), env.DB.get('sess:' + tok)]);
  return ep !== null && Number(ep) === st.epoch;
}

/* ------------------------------ الدرجات ------------------------------ */
// الدرجة: رقم ، أو غ (غائب) ، أو م (مؤجل) ، أو - (بدون درجة)
const GRADE_TOKEN = /^(\d+(?:\.\d+)?|غائب|غ|مؤجل|م|-)$/;
function normGrade(tok) {
  if (tok === '-') return '';
  if (tok[0] === 'غ') return 'غ';
  if (tok[0] === 'م') return 'م';
  return tok;
}
function validGrade(v, sub, examMax) {
  v = digits(clean(v, 10)).replace(AR_DIAC, '').replace(/٫/g, '.').trim();
  if (v === 'غ' || v === 'غائب') return 'غ';
  if (v === 'م' || v === 'مؤجل') return 'م';
  if (!/^\d+(?:\.\d+)?$/.test(v)) return null;
  const max = sub.max || examMax;
  if (max && Number(v) > max) return null;
  return v;
}
function gradeShow(g) { return g === 'غ' ? 'غائب' : (g === 'م' ? 'مؤجل' : g); }
function gradesText(g, subjects) {
  return subjects.filter(x => g[x.id] !== undefined && g[x.id] !== '')
    .map(x => x.name + ': ' + gradeShow(g[x.id])).join(' | ');
}

/*
  سطر الطالب:  الاسم  ثم الدرجات بنفس ترتيب المواد المختارة
  مثال:  علي سعيد علي 40 غ 25
  الفاصل: مسافة أو فاصلة أو Tab
*/
function parseLine(raw, subs, examMax) {
  const line = digits(raw).replace(AR_DIAC, '').replace(/٫/g, '.')
    .replace(/[،,؛;|\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const toks = line.split(' ');
  const vals = [];
  while (toks.length && GRADE_TOKEN.test(toks[toks.length - 1])) vals.unshift(toks.pop());
  const name = toks.join(' ');
  if (!vals.length) return { error: 'لم يتم العثور على درجات بعد الاسم' };
  if (vals.length !== subs.length) {
    return { error: 'عدد الدرجات (' + vals.length + ') لا يساوي عدد المواد المختارة (' + subs.length + ')' };
  }
  if (/\d/.test(name) || name.split(' ').filter(Boolean).length < 3) {
    return { error: 'الاسم يجب أن يكون ثلاثياً على الأقل وبدون أرقام' };
  }
  const grades = {};
  for (let i = 0; i < subs.length; i++) {
    const g = normGrade(vals[i]);
    if (g === '') continue;
    const max = subs[i].max || examMax;
    if (g !== 'غ' && g !== 'م' && max && Number(g) > max) {
      return { error: 'درجة ' + subs[i].name + ' (' + g + ') أكبر من درجة الامتحان (' + max + ')' };
    }
    grades[subs[i].id] = g;
  }
  if (!Object.keys(grades).length) return { error: 'لا توجد أي درجة في هذا السطر' };
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
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function say(env, chatId, text, extra) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, ...(extra || {}) });
}
async function panelView(env, origin) {
  const [chan, app] = await Promise.all([getChan(env), getAppLink(env)]);
  return {
    text: '🎛 <b>لوحة التحكم</b>\n\n' +
      '📡 القناة: ' + (chan ? '<b>' + esc(chan.title) + '</b> ✅' : 'غير مضبوطة ⚠️') + '\n' +
      '🔗 رابط التطبيق: ' + (app ? 'مضبوط ✅' : 'غير مضبوط ⚠️') + '\n\n' +
      'اضغط «فتح لوحة التحكم» لتحصل على رابط دخول خاص (يعمل مرة واحدة ولمدة 5 دقائق)، ويُحفظ دخولك على جهازك.',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔗 فتح لوحة التحكم', callback_data: 'link' }],
        [{ text: '📩 رابط التطبيق', callback_data: 'getlink' }, { text: '📢 نشر في القناة', callback_data: 'post' }],
        [{ text: '📡 ضبط القناة', callback_data: 'setchan' }, { text: '🧪 تجربة التطبيق', web_app: { url: origin + '/' } }],
        [{ text: '🚪 إخراج كل الأجهزة', callback_data: 'logout_all' }]
      ]
    }
  };
}
async function sendPanel(env, chatId, origin) {
  const v = await panelView(env, origin);
  await tg(env, 'sendMessage', { chat_id: chatId, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup });
}

// ضبط القناة: يجب أن يكون البوت مشرفاً فيها
async function setChannel(env, ref) {
  const c = await tgj(env, 'getChat', { chat_id: ref });
  if (!c.ok || !c.result) return { err: '❌ لم أجد هذه القناة. أضفني مشرفاً فيها أولاً ثم أعد المحاولة.' };
  const ch = c.result;
  if (ch.type !== 'channel' && ch.type !== 'supergroup') return { err: '❌ هذه ليست قناة.' };
  const me = await tgj(env, 'getChatMember', { chat_id: ch.id, user_id: Number(botId(env)) });
  if (!me.ok || !me.result || (me.result.status !== 'administrator' && me.result.status !== 'creator')) {
    return { err: '❌ أنا لست مشرفاً في هذه القناة. أضفني كمشرف ثم أعد المحاولة.' };
  }
  const chan = { id: ch.id, title: String(ch.title || '').slice(0, 100), username: ch.username || '' };
  await env.DB.put('chan', JSON.stringify(chan));
  return { chan };
}

// عند إضافة البوت مشرفاً في قناة (من الأدمن) تُضبط القناة تلقائياً
async function handleMyChat(env, u) {
  const chat = u.chat, nm = u.new_chat_member;
  if (!chat || (chat.type !== 'channel' && chat.type !== 'supergroup')) return;
  if (!nm || !nm.user || String(nm.user.id) !== botId(env)) return;
  if (nm.status === 'administrator') {
    if (!u.from || !isAdminId(env, u.from.id)) return;
    const chan = { id: chat.id, title: String(chat.title || '').slice(0, 100), username: chat.username || '' };
    await env.DB.put('chan', JSON.stringify(chan));
    await say(env, u.from.id, '✅ تم ضبط القناة تلقائياً: ' + chan.title + '\nأرسل /start لعرض لوحة البوت.');
  } else if (nm.status === 'left' || nm.status === 'kicked') {
    const cur = await getChan(env);
    if (cur && String(cur.id) === String(chat.id)) await env.DB.delete('chan');
  }
}

async function handleAwait(env, chatId, admId, aw, msg, origin) {
  const txt = String(msg.text || '').trim();
  if (aw === 'chan') {
    let ref = '';
    const fo = msg.forward_origin;
    if (fo && fo.type === 'channel' && fo.chat) ref = fo.chat.id;
    else if (msg.forward_from_chat) ref = msg.forward_from_chat.id;
    else {
      const m = txt.match(/^(?:https?:\/\/)?(?:t\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,})\/?$/);
      if (m) ref = '@' + m[1];
    }
    if (!ref) { await say(env, chatId, 'أرسل معرّف القناة مثل @mychannel أو حوّل لي رسالة منها. (للإلغاء: /cancel)'); return; }
    const r = await setChannel(env, ref);
    if (r.err) { await say(env, chatId, r.err); return; }
    await env.DB.delete('await:' + admId);
    await say(env, chatId, '✅ تم ضبط القناة: ' + r.chan.title);
    await sendPanel(env, chatId, origin);
    return;
  }
  if (aw === 'app') {
    let t = txt.replace(/^http:\/\//i, 'https://');
    if (/^t\.me\//i.test(t)) t = 'https://' + t;
    const ok = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,}(?:\/[A-Za-z][A-Za-z0-9_]{2,})?(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(t);
    if (!ok) { await say(env, chatId, 'الرابط غير صحيح. أرسل الرابط الذي أعطاك إياه BotFather مثل:\nhttps://t.me/yourbot/results\n(للإلغاء: /cancel)'); return; }
    await env.DB.put('applink', t);
    await env.DB.delete('await:' + admId);
    await say(env, chatId, '✅ تم حفظ رابط التطبيق.');
    await sendPanel(env, chatId, origin);
  }
}

async function handleTelegram(env, update, origin) {
  if (update.my_chat_member) { await handleMyChat(env, update.my_chat_member); return; }
  const msg = update.message, cb = update.callback_query;
  const src = msg || cb;
  if (!src || !src.from) return;
  const chat = msg ? msg.chat : (cb.message ? cb.message.chat : null);
  const chatId = chat ? chat.id : src.from.id;

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

  if (chat && chat.type !== 'private') {
    if (cb) await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'استخدم البوت في محادثة خاصة', show_alert: true });
    else await tg(env, 'sendMessage', { chat_id: chatId, text: 'استخدم البوت في محادثة خاصة.' });
    return;
  }

  const admId = src.from.id;
  if (cb) {
    const d = cb.data;
    const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: !!alert });
    if (d === 'link') {
      const st = await getState(env);
      const tok = randHex(24);
      await env.DB.put('lnk:' + tok, String(st.epoch), { expirationTtl: 300 });
      await ack();
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: '🔗 رابط الدخول جاهز.\n\nيعمل مرة واحدة فقط ولمدة 5 دقائق، وبعدها يُحفظ دخولك على هذا الجهاز.\nلا ترسله لأحد.',
        reply_markup: { inline_keyboard: [[{ text: '🎛 دخول لوحة التحكم', url: origin + '/a?t=' + tok }]] }
      });
      return;
    }
    if (d === 'logout_all') {
      const st = await getState(env);
      await putState(env, { epoch: st.epoch + 1 });
      await ack('تم إخراج كل الأجهزة وإلغاء كل الروابط', true);
      return;
    }
    if (d === 'getlink') {
      const app = await getAppLink(env);
      await ack();
      if (!app) {
        await env.DB.put('await:' + admId, 'app', { expirationTtl: 600 });
        await say(env, chatId, 'لم تضبط رابط التطبيق بعد.\n\n1) في BotFather أرسل /newapp واختر هذا البوت، واجعل رابط الموقع:\n' + origin + '/\n2) سيعطيك BotFather رابطاً مثل https://t.me/yourbot/results\n3) أرسل لي هذا الرابط هنا الآن.');
        return;
      }
      await say(env, chatId, '📩 رابط التطبيق:\n\n' + app + '\n\nاضغط الزر لفتحه، أو انسخ الرابط وأرسله حيث تريد.', {
        reply_markup: { inline_keyboard: [[{ text: '🎓 فتح التطبيق', url: app }], [{ text: '✏️ تغيير الرابط', callback_data: 'setapp' }]] }
      });
      return;
    }
    if (d === 'setapp') {
      await env.DB.put('await:' + admId, 'app', { expirationTtl: 600 });
      await ack();
      await say(env, chatId, 'أرسل لي رابط التطبيق الجديد (مثل https://t.me/yourbot/results). للإلغاء: /cancel');
      return;
    }
    if (d === 'setchan') {
      await env.DB.put('await:' + admId, 'chan', { expirationTtl: 600 });
      await ack();
      await say(env, chatId, '📡 لضبط القناة:\n• أضفني مشرفاً في القناة وسأضبطها تلقائياً،\n• أو أرسل لي هنا معرّف القناة مثل @mychannel،\n• أو حوّل لي رسالة منها.\n\n(للإلغاء: /cancel)');
      return;
    }
    if (d === 'post') {
      const [chan, app, s] = await Promise.all([getChan(env), getAppLink(env), getSettings(env)]);
      if (!chan) { await ack('اضبط القناة أولاً', true); return; }
      if (!app) { await ack('اضبط رابط التطبيق أولاً (زر رابط التطبيق)', true); return; }
      const r = await tgj(env, 'sendMessage', {
        chat_id: chan.id, text: s.t.postText,
        reply_markup: { inline_keyboard: [[{ text: s.t.postBtn, url: app }]] }
      });
      await ack(r.ok ? 'تم النشر في القناة ✅' : ('تعذر النشر: ' + String(r.description || '').slice(0, 150)), true);
      return;
    }
    await ack();
    return;
  }

  const aw = await env.DB.get('await:' + admId);
  const txt = String(msg.text || '').trim();
  if (aw && txt !== '/start' && txt !== '/cancel') { await handleAwait(env, chatId, admId, aw, msg, origin); return; }
  if (aw) await env.DB.delete('await:' + admId);
  await sendPanel(env, chatId, origin);
}

/* ------------------------------ المسارات ------------------------------ */
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) {
      // في مسارات لوحة التحكم نُرجع سبب الخطأ الحقيقي (مثل تجاوز حد التخزين اليومي) ليظهر للأدمن
      let detail;
      try {
        if (new URL(request.url).pathname.startsWith('/api/admin/')) detail = String((e && e.message) || e).slice(0, 200);
      } catch (x) {}
      return json({ error: 'server_error', detail }, 500);
    }
  }
};

async function body(request) { try { return await request.json(); } catch (e) { return {}; } }

function htmlResponse(text) {
  return new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS } });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    let cfg;
    try {
      const [s, ch] = await Promise.all([getSettings(env), getChan(env)]);
      cfg = { s: publicSettings(s), ch: ch ? ch.title : '' };
    } catch (e) {
      cfg = { s: publicSettings(DEFAULT_SETTINGS), kvError: true };
    }
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
    return htmlResponse(HTML.replace('/*__CFG__*/null', () => cfgJson));
  }

  /* صفحة الدخول من رابط البوت (لا تستهلك الرابط؛ الاستهلاك يتم بطلب POST) */
  if (method === 'GET' && path === '/a') return htmlResponse(ENTER_HTML);

  /* --- تيليجرام --- */
  if (path === '/telegram' && method === 'POST') {
    const sec = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!env.WEBHOOK_SECRET || !safeEq(sec, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
    try { await handleTelegram(env, await request.json(), url.origin); } catch (e) {}
    return new Response('ok');
  }
  if (path === '/setup' && method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!env.WEBHOOK_SECRET || !safeEq(key, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
    const r = await tg(env, 'setWebhook', {
      url: url.origin + '/telegram', secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member']
    });
    return new Response(await r.text(), { headers: { 'content-type': 'application/json' } });
  }

  /* --- عام --- */
  if (path === '/api/config' && method === 'GET') {
    const [s, ch] = await Promise.all([getSettings(env), getChan(env)]);
    return json({ s: publicSettings(s), ch: ch ? ch.title : '' });
  }

  /* --- التحقق من الطالب (تطبيق تيليجرام فقط) --- */
  if (path === '/api/tg/status' && method === 'POST') {
    const b = await body(request);
    const g = await tgGate(env, b);
    if (g.state === 'badinit') return json({ state: 'badinit' }, 401);
    return json({ state: g.state, admin: !!g.admin, channel: chanInfo(g.chan) });
  }

  if (path === '/api/tg/search' && method === 'POST') {
    const b = await body(request);
    const g = await tgGate(env, b);
    if (g.state === 'badinit') return json({ state: 'badinit' }, 401);
    if (g.state !== 'ready') return json({ state: g.state, admin: !!g.admin, channel: chanInfo(g.chan) }, 403);
    const q = normName(clean(b.name, 120));
    const words = q.split(' ').filter(Boolean);
    if (words.length < 3) return json({ error: 'short' }, 400);
    // حماية من التخمين الجماعي فقط (الأخطاء الإملائية العادية لا تُحسب كمحاولة)
    const fk = 'f:' + g.user.id;
    const fails = Number(await env.DB.get(fk)) || 0;
    if (!g.admin && fails >= 60) return json({ error: 'toomany' }, 429);
    const [s, students] = await Promise.all([getSettings(env), getStudents(env)]);
    const found = students.filter(x => x.k === q || (words.length === 3 && firstThree(x.k) === q));
    // لو البحث بثلاثي وطلع نتيجة لكن الطالب مسجَّل برباعي → اطلب الرباعي
    if (words.length === 3 && found.length === 1 && found[0].k.split(' ').length > 3) return json({ error: 'needfull' }, 300);
    // لو البحث بثلاثي وطلع أكثر من طالب بنفس الثلاثي → اطلب الرباعي
    if (words.length === 3 && found.length > 1) return json({ error: 'needfull' }, 300);
    const results = found.slice(0, 5).map(st => {
      const rows = [];
      for (const sub of s.subjects) {
        const gr = st.g[sub.id];
        if (gr === undefined || gr === '') continue;
        const max = sub.max || s.examMax || 0;
        if (gr === 'غ') { rows.push({ n: sub.name, g: 'غائب', max: 0, bad: true, sp: 0 }); continue; }
        if (gr === 'م') { rows.push({ n: sub.name, g: 'مؤجل', max: 0, bad: false, sp: 1 }); continue; }
        const num = parseFloat(gr);
        const bad = isNaN(num) || (s.passPercent > 0 && max > 0 && num < (max * s.passPercent) / 100);
        rows.push({ n: sub.name, g: gr, max, bad, sp: 0 });
      }
      return { name: st.n, rows };
    });
    if (!results.length) {
      if (!g.admin) await env.DB.put(fk, String(fails + 1), { expirationTtl: 3600 });
      return json({ error: 'notfound' }, 404);
    }
    // ظهرت نتيجة فعلية: تُستهلك المحاولة الوحيدة للحساب والجهاز
    if (!g.admin) {
      const meta = {
        un: clean(g.user.username, 40),
        fn: clean(((g.user.first_name || '') + ' ' + (g.user.last_name || '')).trim(), 40),
        n: clean(results.map(r => r.name).join('، '), 150),
        t: Date.now(), dev: (g.devs || [])[0] || '', devs: g.devs || []
      };
      await Promise.all([
        env.DB.put('u:' + g.user.id, JSON.stringify(meta), { metadata: meta }),
        ...(g.devs || []).map(x => env.DB.put('d:' + x, String(g.user.id)))
      ]);
    }
    return json({ results });
  }

  /* --- الدخول من رابط البوت (مرة واحدة) --- */
  if (path === '/api/admin/enter' && method === 'POST') {
    const b = await body(request);
    const t = clean(b.t, 60);
    if (!/^[a-f0-9]{48}$/.test(t)) return json({ error: 'bad_link' }, 401);
    const [v, st] = await Promise.all([env.DB.get('lnk:' + t), getState(env)]);
    if (v === null) return json({ error: 'bad_link' }, 401);
    await env.DB.delete('lnk:' + t);
    if (Number(v) !== st.epoch) return json({ error: 'bad_link' }, 401);
    const tok = randHex(24);
    await env.DB.put('sess:' + tok, String(st.epoch), { expirationTtl: 31536000 }); // 365 يوماً
    return json({ token: tok });
  }

  /* --- كل ما بعد هذا يتطلب جلسة --- */
  if (path.startsWith('/api/admin/')) {
    if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/admin/ping' && method === 'GET') return json({ ok: true });

    if (path === '/api/admin/logout' && method === 'POST') {
      await env.DB.delete('sess:' + bearer(request));
      return json({ ok: true });
    }

    if (path === '/api/admin/data' && method === 'GET') {
      const [s, students] = await Promise.all([getSettings(env), getStudents(env)]);
      return json({ settings: s, students: students.map(x => ({ id: x.id, n: x.n, sec: x.sec || '', g: x.g })) });
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

    /* --- المحاولات (من استخدم محاولته) --- */
    if (path === '/api/admin/attempts' && method === 'GET') {
      const items = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await env.DB.list({ prefix: 'u:', cursor });
        for (const k of r.keys) items.push({ uid: k.name.slice(2), ...(k.metadata || {}) });
        if (r.list_complete) break;
        cursor = r.cursor;
      }
      items.sort((a, b) => (b.t || 0) - (a.t || 0));
      const [chan, app] = await Promise.all([getChan(env), getAppLink(env)]);
      return json({ items, channel: chanInfo(chan), applink: app });
    }
    if (path === '/api/admin/attempts/reset' && method === 'POST') {
      const b = await body(request);
      const uid = String(b.uid || '').replace(/\D/g, '').slice(0, 20);
      if (!uid) return json({ error: 'bad' }, 400);
      const v = await env.DB.get('u:' + uid, 'json');
      await env.DB.delete('u:' + uid);
      if (v) {
        for (const x of [].concat(v.devs || [], [v.dev || ''])) {
          if (x && (await env.DB.get('d:' + x)) === uid) await env.DB.delete('d:' + x);
        }
      }
      return json({ ok: true });
    }


    /* --- الشعب --- */
    if (path === '/api/admin/sections' && method === 'POST') {
      const b = await body(request);
      const name = clean(b.name, 30).replace(/\s+/g, ' ').trim();
      if (!name) return json({ error: 'اكتب اسم الشعبة' }, 400);
      const s = await getSettings(env);
      const key = normName(name);
      const exist = s.sections.find(x => normName(x) === key);
      if (exist) return json({ sections: s.sections, name: exist, existed: true });
      if (s.sections.length >= 60) return json({ error: 'عدد الشعب كبير جداً' }, 400);
      s.sections.push(name);
      await putSettings(env, s);
      return json({ sections: s.sections, name });
    }
    if (path === '/api/admin/sections/delete' && method === 'POST') {
      const b = await body(request);
      const key = normName(clean(b.name, 30));
      const s = await getSettings(env);
      s.sections = s.sections.filter(x => normName(x) !== key);
      await putSettings(env, s);
      const students = await getStudents(env);
      const rest = students.filter(x => normName(x.sec || '') !== key);
      const removed = students.length - rest.length;
      if (removed) await putStudents(env, rest);
      return json({ sections: s.sections, removed });
    }

    /* --- إضافة الطلاب دفعة واحدة إلى شعبة --- */
    if (path === '/api/admin/students/bulk' && method === 'POST') {
      const b = await body(request);
      const s = await getSettings(env);
      if (!s.subjects.length) return json({ error: 'أضف المواد أولاً من تبويب المواد' }, 400);
      if (!s.examMax) return json({ error: 'حدد درجة الامتحان أولاً' }, 400);
      const secKey = normName(clean(b.section, 30));
      const secName = s.sections.find(x => normName(x) === secKey);
      if (!secName) return json({ error: 'اختر الشعبة أولاً' }, 400);
      const pick = new Set(Array.isArray(b.subjects) ? b.subjects.map(String) : []);
      const subs = s.subjects.filter(x => pick.has(x.id));
      if (!subs.length) return json({ error: 'اختر مادة واحدة على الأقل' }, 400);

      const lines = clean(b.text, 400000).split(/\r?\n/).slice(0, 5000);
      const students = await getStudents(env);
      const map = new Map(students.map(x => [x.k, x]));
      const newIds = new Set();
      let added = 0;
      const failed = [], dups = [];
      for (const raw of lines) {
        if (!raw.trim()) continue;
        const r = parseLine(raw, subs, s.examMax);
        if (!r) continue;
        if (r.error) { failed.push({ line: raw.trim(), reason: r.error }); continue; }
        const k = normName(r.name);
        const ex = map.get(k);
        if (ex) {
          dups.push({
            id: ex.id, name: ex.n, sec: ex.sec || '', same: newIds.has(ex.id),
            old: gradesText(ex.g, s.subjects), nw: gradesText(r.grades, s.subjects), grades: r.grades,
            over: Object.keys(r.grades).some(id => ex.g[id] !== undefined && ex.g[id] !== '' && ex.g[id] !== r.grades[id])
          });
          continue;
        }
        const st = { id: randHex(6), n: r.name, k, sec: secName, g: r.grades };
        students.push(st); map.set(k, st); newIds.add(st.id); added++;
      }
      if (added) await putStudents(env, students);
      return json({ added, failed, dups, total: students.length, section: secName });
    }

    /* --- تحديث درجات الأسماء المكررة بعد موافقة الأدمن --- */
    if (path === '/api/admin/students/apply' && method === 'POST') {
      const b = await body(request);
      const s = await getSettings(env);
      const students = await getStudents(env);
      const byId = new Map(students.map(x => [x.id, x]));
      let updated = 0;
      for (const it of Array.isArray(b.items) ? b.items.slice(0, 5000) : []) {
        const st = byId.get(String(it && it.id));
        if (!st || !it.grades || typeof it.grades !== 'object') continue;
        let any = false;
        for (const sub of s.subjects) {
          if (it.grades[sub.id] === undefined) continue;
          const v = validGrade(it.grades[sub.id], sub, s.examMax);
          if (v === null) continue;
          st.g[sub.id] = v; any = true;
        }
        if (any) updated++;
      }
      if (updated) await putStudents(env, students);
      return json({ updated });
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
        const other = students.find((x, j) => j !== i && x.k === k);
        if (other) {
          return json({ error: 'يوجد طالب بنفس الاسم' + (other.sec ? ' في الشعبة ' + other.sec : '') }, 409);
        }
        const secKey = normName(clean(b.sec, 30));
        const sec = secKey ? (s.sections.find(x => normName(x) === secKey) || '') : '';
        const g = {};
        for (const sub of s.subjects) {
          const raw = clean(b.g && b.g[sub.id], 10).trim();
          if (raw === '' || raw === '-') continue;
          const v = validGrade(raw, sub, s.examMax);
          if (v === null) {
            return json({ error: 'درجة «' + sub.name + '» غير صالحة (اكتب رقماً، أو غ للغائب، أو م للمؤجل، ولا تزيد على درجة الامتحان)' }, 400);
          }
          g[sub.id] = v;
        }
        students[i] = { ...students[i], n: name, k, sec, g };
        await putStudents(env, students);
        return json({ student: { id: students[i].id, n: name, sec, g } });
      }
    }
    return json({ error: 'not_found' }, 404);
  }

  return new Response('Not found', { status: 404 });
}

/* ===================================================================
   صفحة الدخول من رابط البوت
   (لا تستخدم علامة ` ولا ${ داخل هذا القسم)
   =================================================================== */
const ENTER_HTML = String.raw`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>دخول</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6fb;font-family:Tahoma,Arial,sans-serif;color:#333}
.b{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:30px 26px;max-width:380px;width:88%;text-align:center;line-height:1.9;font-size:17px}
a{color:#3b82f6}
</style>
</head>
<body>
<div class="b"><div id="m">جاري الدخول...</div><p id="h" style="font-size:13px;color:#888;margin:10px 0 0"></p></div>
<script>
(async function(){
  var m=document.getElementById('m'),h=document.getElementById('h');
  var t=new URLSearchParams(location.search).get('t')||'';
  for(var i=0;i<6;i++){
    try{
      var r=await fetch('/api/admin/enter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:t})});
      var d={};try{d=await r.json();}catch(e){}
      if(r.ok&&d.token){
        var saved=false;
        try{localStorage.setItem('tk',d.token);saved=true;}catch(e){}
        try{document.cookie='tk='+d.token+';max-age=31536000;path=/;SameSite=Lax;Secure';if(/(?:^|; )tk=/.test(document.cookie))saved=true;}catch(e){}
        if(!saved){m.textContent='تعذر حفظ الدخول في هذا المتصفح (ربما التصفح الخاص).';return;}
        m.textContent='تم الدخول ✅';location.replace('/?admin=1');return;
      }
    }catch(e){}
    if(i<5){h.textContent='جاري التحقق من الرابط...';await new Promise(function(ok){setTimeout(ok,5000);});}
  }
  h.textContent='';
  m.textContent='الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب رابطاً جديداً من البوت.';
})();
</script>
</body>
</html>`;

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
<script src="https://telegram.org/js/telegram-web-app.js"></script>
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
td.pend{color:var(--muted)}
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
/* الشعب والمواد المختارة */
.secbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.secbar button{background:#e5e9f2;color:#333}
.secbar button.on{background:var(--primary);color:#fff}
.secbar button.add{background:var(--btn2);color:#fff}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.chip{background:#fff;color:#333;border:1px solid #cfd6e4}
.chip.on{background:var(--primary);color:#fff;border-color:var(--primary)}
.guide{background:#f4f6fb;border:1px dashed #b9c3d9;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:15px;line-height:2.1}
.guide .gs{display:inline-block;background:#fff;border:1px solid #cfd6e4;border-radius:8px;padding:0 10px;margin:0 2px;font-weight:700}
.guide .gn{color:var(--primary)}
.tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:600;margin-inline-start:6px}
.dup{border:1px solid #e3e6eb;border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:14px;line-height:1.8}
.curs{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:15px}
.adm select,.modal select{font-family:inherit;font-size:15px;padding:10px;border:1px solid #cfd6e4;border-radius:8px;background:#fff;color:#222;width:100%}
/* ===== شاشات التحقق (تطبيق تيليجرام) ===== */
.gate{max-width:520px;margin:5vh auto 0;font-size:16px;text-align:center}
.gcard{background:var(--card);border-radius:26px;box-shadow:0 14px 40px rgba(0,0,0,.12);padding:40px 26px 34px;position:relative;overflow:hidden;animation:gin .6s ease backwards}
@keyframes gin{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:none}}
.gcard.red{box-shadow:0 20px 60px rgba(220,38,38,.22);border:1px solid rgba(220,38,38,.18);animation:gin .5s ease backwards}
.gcard.red::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(220,38,38,.09),transparent 65%);pointer-events:none;border-radius:inherit}
.gring{width:132px;height:132px;margin:0 auto 22px;position:relative}
.gring svg{width:100%;height:100%;display:block;overflow:visible}
.gring .trk{fill:none;stroke:#e3e6eb;stroke-width:6}
.gring .arc{fill:none;stroke:var(--primary);stroke-width:6;stroke-linecap:round;stroke-dasharray:90 250;transform-origin:60px 60px;animation:sp 1s linear infinite}
.gring .shd{fill:var(--primary);opacity:.9;transform-origin:60px 60px;animation:bt 1.4s ease-in-out infinite alternate}
@keyframes bt{from{transform:scale(.88)}to{transform:scale(1.06)}}
.gring .lkb{fill:var(--primary)}
.gring .lks{fill:none;stroke:var(--primary);stroke-width:7;stroke-linecap:round}
.gring .okbg{fill:#22c55e;transform-origin:60px 60px;transform:scale(0);animation:grow .8s cubic-bezier(.2,1.5,.35,1) forwards}
.gring .okring{fill:none;stroke:#22c55e;stroke-width:4;transform-origin:60px 60px;opacity:0;animation:ripple 1.7s ease-out .55s infinite}
.gring .okchk{fill:none;stroke:#fff;stroke-width:9;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:90;stroke-dashoffset:90;animation:draw .5s ease .6s forwards}
.gring .rbg{fill:#dc2626;transform-origin:60px 60px;transform:scale(0);animation:grow .6s cubic-bezier(.2,1.4,.4,1) .05s forwards}
.gring .rlkb{fill:none;stroke:#fff;stroke-width:0;fill:#fff;opacity:0;animation:fin .3s ease .5s forwards}
.gring .rlks{fill:none;stroke:#fff;stroke-width:7;stroke-linecap:round;stroke-dasharray:80;stroke-dashoffset:80;animation:draw .4s ease .55s forwards}
.gring .rlkl{fill:none;stroke:rgba(255,255,255,.7);stroke-width:5.5;stroke-linecap:round;stroke-dasharray:20;stroke-dashoffset:20;animation:draw .25s ease .9s forwards}
.gring .rdot{fill:#fff;opacity:0;animation:fin .3s ease .85s forwards}
.gring .rx{fill:none;stroke:#fff;stroke-width:7;stroke-linecap:round;stroke-dasharray:60;stroke-dashoffset:60;animation:draw .4s ease .55s forwards}
@keyframes grow{from{transform:scale(0)}to{transform:scale(1)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fin{to{opacity:1}}
@keyframes ripple{0%{opacity:.75;transform:scale(.92)}100%{opacity:0;transform:scale(1.6)}}
.pt{position:absolute;left:50%;top:50%;width:9px;height:9px;margin:-4px;border-radius:50%;background:var(--pc,#22c55e);opacity:0;animation:burst 1.1s ease-out .65s forwards}
@keyframes burst{0%{opacity:1;transform:rotate(var(--a)) translateX(0) scale(1)}100%{opacity:0;transform:rotate(var(--a)) translateX(96px) scale(.3)}}
.gt{font-size:28px;font-weight:700;margin:0 0 10px;color:#111;animation:rise .6s ease .35s backwards;position:relative}
.gcard.red .gt{color:#e53935;text-shadow:0 0 18px rgba(229,57,53,.35)}
.gcard.okc .gt{color:#16a34a}
.gs{font-size:17px;line-height:1.9;color:#555;margin:0 auto;max-width:400px;animation:rise .6s ease .5s backwards;position:relative}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.gchip{display:inline-block;margin:16px 0 4px;background:#fff1f0;color:#c62828;border:1px solid #ffcdd2;border-radius:999px;padding:7px 20px;font-weight:700;font-size:18px;animation:rise .6s ease .6s backwards;position:relative}
.gcard:not(.red) .gchip{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
.gbtns{margin-top:18px;position:relative}
.gb{height:auto;padding:12px 26px;font-size:16px;margin:6px 5px;border-radius:12px}
.snote{text-align:center;background:#fff8e1;color:#8a6d00;border:1px solid #ffe08a;border-radius:10px;padding:9px 12px;font-size:14px;line-height:1.8;margin:0 0 26px}
@media(prefers-reduced-motion:reduce){.gcard,.gcard *{animation-duration:.01s!important;animation-delay:0s!important}}
@media(max-width:640px){.subj{grid-template-columns:1fr 1fr}.srow{grid-template-columns:1fr 1fr}.scard{padding:26px 20px 30px}.s1{font-size:30px}}
@media print{body{background:#fff}.actions,.bar{display:none!important}.card{box-shadow:none;border:1px solid #ddd}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<div id="bar" class="bar hidden"><button id="barBtn" data-t="panelBar"></button></div>

<div class="wrap">

<!-- ================= صفحة البحث ================= -->
<!-- ================= شاشات التحقق ================= -->
<div id="viewGate" class="gate"><div id="gateBox"></div></div>

<div id="viewSearch" class="sc hidden">
  <div class="scard">
    <div class="slogo hidden" id="sLogo"></div>
    <h1 class="s1" data-t="country"></h1>
    <h2 class="s2" data-t="ministry"></h2>
    <p class="s3" data-t="subtitle"></p>
    <div class="snote">تنبيه: لديك محاولة واحدة فقط لعرض النتيجة، فتأكد من كتابة اسمك الثلاثي بشكل صحيح.</div>
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
      <button class="b-back" id="btnExit">العودة للموقع</button>
      <button class="b-gray" id="btnLogout">تسجيل الخروج من هذا الجهاز</button>
    </div>
  </div>
  <div class="tabs" id="tabs">
    <button data-tab="Add" class="on">إضافة الطلاب</button>
    <button data-tab="Subj">المواد</button>
    <button data-tab="Stud">تعديل الطلاب وإدارتهم</button>
    <button data-tab="Att">المحاولات</button>
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
    <div class="card" id="step2">
      <h2>الخطوة 2: اختر الشعبة ثم سجّل الطلاب</h2>
      <div class="secbar" id="secBar"></div>
      <p class="small hidden" id="noSec">أضف شعبة أولاً (اكتب حرفاً أو كلمة مثل: أ أو ب) ليظهر مكان تسجيل الطلاب.</p>
      <div id="entry" class="hidden">
        <div class="curs">
          <div>الشعبة الحالية: <b id="curSec"></b></div>
          <button class="b-red sm" id="btnDelSec">حذف هذه الشعبة</button>
        </div>
        <p class="small errt hidden" id="needMax">⚠️ حدد درجة الامتحان في الخطوة 1 واضغط «حفظ والمتابعة» لتفعيل تسجيل الطلاب.</p>
        <div id="entryBody" class="locked">
          <p class="small" style="margin-bottom:6px">اختر المواد التي ستُدخل درجاتها الآن:</p>
          <div class="chips" id="subjChips"></div>
          <div class="guide" id="guide"></div>
          <textarea id="bulkText"></textarea>
          <div class="actions"><button class="b-print" id="btnBulk">تم</button></div>
          <div id="bulkRes" style="margin-top:12px;font-size:15px;line-height:1.9"></div>
        </div>
      </div>
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
      <div class="grid" style="margin-bottom:10px">
        <select id="stSec"></select>
        <input type="text" id="stQ" placeholder="ابحث عن طالب بالاسم...">
      </div>
      <div id="stList" style="margin-top:10px"></div>
      <div class="actions"><button class="b-red" id="btnClearAll">حذف جميع الطلاب</button></div>
    </div>
  </div>

  <div id="tabAtt" class="hidden">
    <div class="card" id="attInfo"></div>
    <div class="card">
      <h2>من استخدم محاولته <span class="small" id="attCount"></span></h2>
      <p class="small">كل حساب أو جهاز يظهر هنا لن يستطيع عرض نتيجة أخرى. اضغط «إعادة المحاولة» ليتمكن من البحث من جديد (مثلاً: أخوان على هاتف واحد).</p>
      <input type="text" id="attQ" placeholder="ابحث بالاسم أو المعرّف...">
      <div id="attList" style="margin-top:10px"></div>
    </div>
  </div>

  <div id="tabSet" class="hidden"></div>
</div>

</div>

<script>
var BOOT=/*__CFG__*/null;
function getTok(){
  var v='';
  try{v=localStorage.getItem('tk')||'';}catch(e){}
  if(/^[a-f0-9]{48}$/.test(v))return v;
  var m=document.cookie.match(/(?:^|; )tk=([a-f0-9]{48})/);
  v=m?m[1]:'';
  if(v){try{localStorage.setItem('tk',v);}catch(e){}}
  return v;
}
function setTok(v){
  try{if(v)localStorage.setItem('tk',v);else localStorage.removeItem('tk');}catch(e){}
  try{document.cookie=v?('tk='+v+';max-age=31536000;path=/;SameSite=Lax;Secure'):'tk=;max-age=0;path=/;SameSite=Lax;Secure';}catch(e){}
}
function errMsg(r){
  var d=(r&&r.data)||{};
  if(r&&r.status===0)return 'تعذر الاتصال بالخادم';
  if(d.error==='server_error'){
    var x=String(d.detail||'');
    if(/limit|429|too many/i.test(x))return 'تم تجاوز الحد اليومي لتخزين Cloudflare KV في الخطة المجانية (يتجدد يومياً تلقائياً). حاول لاحقاً أو رقِّ الخطة.';
    return 'خطأ في الخادم'+(x?(': '+x):'');
  }
  return d.error||'حدث خطأ';
}
var C=BOOT,TOKEN=getTok(),ADMIN_OK=false,AD=null,ST=null,TAB='Add';
var SEC='',PICK={},SEEN={},DRAFT={},ASKED=false;
var TG=(window.Telegram&&window.Telegram.WebApp)?window.Telegram.WebApp:null;
var INIT=(TG&&TG.initData)?TG.initData:'',ISADMIN=false;
var $=function(id){return document.getElementById(id);};
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
var CHECK_SVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l8 3.2v6.1c0 4.9-3.3 8.6-8 10.2-4.7-1.6-8-5.3-8-10.2V5.7z"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>';
var TL=[['schoolName','اسم المدرسة (ثابت لكل الطلاب)'],['country','العنوان الكبير'],['ministry','العنوان تحته'],['subtitle','نص منصة إعلان النتائج'],['searchLabel','عنوان خانة الاسم'],['searchPlaceholder','النص داخل خانة الاسم'],['searchBtn','نص زر إظهار النتيجة'],['errShort','رسالة: الاسم غير مكتمل'],['errNotFound','رسالة: لا توجد نتيجة'],['errNeedFull','رسالة: يوجد اسم مشابه (اكتب الرباعي)'],['errServer','رسالة: خطأ في الاتصال'],['committee','النص الأيسر في صفحة النتيجة'],['title','عنوان النتيجة'],['section','عنوان معلومات الطالب'],['tableTitle','عنوان جدول النتيجة'],['lName','تسمية الاسم'],['lSchool','تسمية المدرسة'],['note','الملاحظة أسفل البطاقة (ضع ** حول الكلمات العريضة)'],['thSubj','عمود المادة'],['thGrade','عمود الدرجة'],['ofText','كلمة (من) بجانب الدرجة'],['btnPrint','زر الطباعة'],['btnBack','زر العودة'],['panelBar','زر لوحة التحكم أعلى الموقع'],['boxText','النص المتحرك فوق زر إظهار النتيجة (اتركه فارغاً لإخفائه)'],['postText','نص المنشور الذي يرسله البوت إلى القناة'],['postBtn','نص زر المنشور في القناة']];
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
function show(v){['viewGate','viewSearch','viewResult','viewAdmin'].forEach(function(x){$(x).classList.add('hidden');});$(v).classList.remove('hidden');window.scrollTo(0,0);}

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
    TOKEN='';setTok('');ADMIN_OK=false;
    alert('انتهت الجلسة أو تم إخراج هذا الجهاز. ادخل مرة أخرى من رابط البوت.');
    loadConfig().then(function(){startApp();});
    return true;
  }
  return false;
}

/* ---------- الإعدادات العامة ---------- */
async function loadConfig(){
  var r=await api('/api/config');
  if(r.ok){C=r.data;}
  else if(!C){C={s:{t:{},colors:{},logo:'',boxImage:'',noteIcon:'',examMax:0,passPercent:50}};}
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
  var vis=!!ADMIN_OK;
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
  var r=await api('/api/tg/search','POST',{init:INIT,devs:await devId(),name:name});
  var w=900-(Date.now()-t0);if(w>0)await sleep(w);
  setLoading(false);
  if(r.ok){renderResults(r.data.results);$('btnBack').classList.toggle('hidden',!ISADMIN);show('viewResult');}
  else if(r.status===404)showErr(t.errNotFound||'');
  else if(r.status===400)showErr(t.errShort||'');
  else if(r.status===300)showErr(t.errNeedFull||'يوجد اسم مشابه، اكتب اسمك الرباعي.');
  else if(r.status===401)showGate('expired');
  else if(r.status===403)showGate(r.data.state||'done',r.data);
  else if(r.status===429)showErr('محاولات بحث كثيرة، حاول بعد قليل');
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
    var td=el('td',{class:x.bad?'bad':(x.sp?'pend':'')},[String(x.g)]);
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

/* ---------- لوحة التحكم (الدخول يتم من رابط البوت) ---------- */
$('barBtn').onclick=async function(){
  var ok=await loadAdmin(false);
  if(!ok&&!TOKEN)alert('انتهت الجلسة. ادخل مرة أخرى من رابط البوت.');
};
async function loadAdmin(silent){
  var r=await api('/api/admin/data','GET',undefined,true);
  if(r.status===401){TOKEN='';setTok('');ADMIN_OK=false;applySettings();return false;}
  if(!r.ok){if(!silent)alert('تعذر تحميل البيانات');return false;}
  AD=r.data;C.s=Object.assign({},AD.settings);delete C.s.subjects;delete C.s.sections;applySettings();
  show('viewAdmin');setTab(TAB);return true;
}
async function refreshData(){
  var r=await api('/api/admin/data','GET',undefined,true);
  if(authFail(r))return false;
  if(r.ok){AD=r.data;return true;}
  return false;
}
$('btnExit').onclick=async function(){await loadConfig();startApp();};
$('btnLogout').onclick=async function(){
  if(!confirm('سيتم تسجيل خروج هذا الجهاز، ويختفي زر لوحة التحكم منه حتى تدخل مرة أخرى من رابط البوت. متابعة؟'))return;
  await api('/api/admin/logout','POST',{},true);
  TOKEN='';setTok('');ADMIN_OK=false;await loadConfig();startApp();toast('تم تسجيل الخروج');
};

/* ---------- التبويبات ---------- */
document.querySelectorAll('#tabs button').forEach(function(b){b.onclick=function(){setTab(b.getAttribute('data-tab'));};});
async function setTab(t){
  TAB=t;
  document.querySelectorAll('#tabs button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tab')===t);});
  ['Add','Subj','Stud','Att','Set'].forEach(function(x){$('tab'+x).classList.toggle('hidden',x!==t);});
  if(t==='Stud'||t==='Add'){var ok=await refreshData();if(!ok)return;}
  if(t==='Add')renderAdd();
  if(t==='Subj')renderSubj();
  if(t==='Stud'){fillSecSel();renderStud();}
  if(t==='Set')renderSet();
  if(t==='Att')renderAtt();
}

/* ---------- إضافة الطلاب ---------- */
function secList(){return (AD.settings.sections||[]);}
function secCount(name){var k=foldC(name);return AD.students.filter(function(s){return foldC(s.sec||'')===k;}).length;}
function pickedSubs(){return AD.settings.subjects.filter(function(x){return PICK[x.id];});}
function switchSec(n){
  DRAFT[SEC]=$('bulkText').value;
  SEC=n;
  $('bulkText').value=DRAFT[n]||'';
}
function renderAdd(){
  var s=AD.settings;
  $('exMax').value=s.examMax||'';
  // إضافة/حذف الشعب متاحة دائماً؛ يُقفل فقط صندوق إدخال الدرجات إذا لم تُحدد درجة الامتحان
  $('entryBody').classList.toggle('locked',!s.examMax);
  $('needMax').classList.toggle('hidden',!!s.examMax);
  var secs=secList();
  if(SEC&&secs.indexOf(SEC)<0)SEC='';
  if(!SEC&&secs.length)switchSec(secs[0]);
  s.subjects.forEach(function(x){if(!SEEN[x.id]){SEEN[x.id]=true;PICK[x.id]=true;}});
  renderSecBar();
  renderChips();
  if(!secs.length&&s.examMax&&!ASKED){ASKED=true;openSecModal();}
}
function renderSecBar(){
  var box=$('secBar');box.innerHTML='';
  secList().forEach(function(n){
    box.appendChild(el('button',{class:n===SEC?'on':'',text:n+' ('+secCount(n)+')',onclick:function(){switchSec(n);renderAdd();}}));
  });
  box.appendChild(el('button',{class:'add',text:'+ شعبة جديدة',onclick:openSecModal}));
  $('entry').classList.toggle('hidden',!SEC);
  $('noSec').classList.toggle('hidden',!!SEC);
  $('curSec').textContent=SEC;
}
function renderChips(){
  var s=AD.settings,box=$('subjChips');box.innerHTML='';
  if(!s.subjects.length)box.appendChild(el('p',{class:'small',text:'⚠️ لا توجد مواد بعد. أضفها من تبويب «المواد».'}));
  s.subjects.forEach(function(x){
    box.appendChild(el('button',{class:'chip'+(PICK[x.id]?' on':''),text:(PICK[x.id]?'✓ ':'')+x.name,onclick:function(){PICK[x.id]=!PICK[x.id];renderChips();}}));
  });
  renderGuide();
}
function renderGuide(){
  var g=$('guide'),subs=pickedSubs(),ta=$('bulkText');g.innerHTML='';
  if(!subs.length){g.textContent='اختر مادة واحدة على الأقل من الأزرار أعلاه.';ta.setAttribute('placeholder','');return;}
  var row=el('div',null,[el('span',{text:'الترتيب: '}),el('span',{class:'gs',text:'الاسم'})]);
  subs.forEach(function(x,i){
    row.appendChild(document.createTextNode(' ← '));
    row.appendChild(el('span',{class:'gs'},[el('span',{class:'gn',text:(i+1)+' '}),x.name]));
  });
  var nums=[40,35,28,45,30,38],e1='علي سعيد علي',e2='سارة محمد حسن';
  subs.forEach(function(x,i){e1+=' '+nums[i%6];e2+=' '+(i===1?'غ':(i===2?'م':nums[(i+2)%6]));});
  g.appendChild(row);
  g.appendChild(el('div',{text:'مثال: '+e1}));
  g.appendChild(el('div',{text:'مثال: '+e2}));
  g.appendChild(el('div',{class:'small',style:'margin:0',text:'غ = غائب ، م = مؤجل ، - = بدون درجة. كل طالب في سطر مستقل، ويكفي فراغ بين الدرجات.'}));
  ta.setAttribute('placeholder',e1+'\n'+e2);
}
function openSecModal(){
  var inp=el('input',{type:'text',placeholder:'مثال: أ'});
  var err=el('p',{class:'errt hidden',style:'font-size:14px;margin:8px 0 0'});
  var modal=el('div',{class:'modal'});
  async function ok(){
    var name=inp.value.trim();
    if(!name){err.textContent='اكتب حرفاً أو كلمة';err.classList.remove('hidden');return;}
    var r=await api('/api/admin/sections','POST',{name:name},true);if(authFail(r))return;
    if(r.ok){
      AD.settings.sections=r.data.sections;
      switchSec(r.data.name);
      modal.remove();renderAdd();
      toast(r.data.existed?'الشعبة موجودة، تم الانتقال إليها':'تمت إضافة الشعبة');
    }else{err.textContent=errMsg(r);err.classList.remove('hidden');}
  }
  inp.onkeydown=function(e){if(e.key==='Enter')ok();};
  var card=el('div',{class:'mcard'},[
    el('h3',{text:'شعبة جديدة'}),
    el('p',{class:'small',text:'اكتب حرف أو كلمة الشعبة (مثل: أ أو ب أو الأولى). بعدها يظهر مكان تسجيل الطلاب.'}),
    inp,err,
    el('div',{style:'display:flex;gap:8px;margin-top:14px'},[
      el('button',{class:'b-print',text:'متابعة',onclick:ok}),
      el('button',{class:'b-gray',text:'إلغاء',onclick:function(){modal.remove();}})])]);
  modal.appendChild(card);document.body.appendChild(modal);inp.focus();
}
$('btnDelSec').onclick=async function(){
  if(!SEC)return;
  var n=secCount(SEC);
  if(!confirm('سيتم حذف الشعبة «'+SEC+'»'+(n?' وجميع طلابها ('+n+' طالب)':'')+'. متابعة؟'))return;
  var r=await api('/api/admin/sections/delete','POST',{name:SEC},true);if(authFail(r))return;
  if(r.ok){
    AD.settings.sections=r.data.sections;delete DRAFT[SEC];SEC='';$('bulkText').value='';
    await refreshData();renderAdd();toast('تم حذف الشعبة');
  }
};
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
  }else alert(errMsg(r));
};
$('btnBulk').onclick=async function(){
  if(!SEC){alert('اختر الشعبة أولاً');return;}
  var subs=pickedSubs();
  if(!subs.length){alert('اختر مادة واحدة على الأقل');return;}
  var text=$('bulkText').value;
  if(!text.trim()){alert('اكتب الطلاب أولاً');return;}
  var btn=$('btnBulk');btn.disabled=true;
  var r=await api('/api/admin/students/bulk','POST',{section:SEC,subjects:subs.map(function(x){return x.id;}),text:text},true);
  btn.disabled=false;
  if(authFail(r))return;
  var box=$('bulkRes');box.innerHTML='';
  if(!r.ok){box.appendChild(el('div',{class:'errt',text:errMsg(r)}));return;}
  var d=r.data;
  box.appendChild(el('div',{class:'ok',text:'✅ تمت إضافة '+d.added+' طالب إلى الشعبة «'+SEC+'» (إجمالي الطلاب: '+d.total+')'}));
  if(d.dups.length)box.appendChild(el('div',{class:'errt',text:'⚠️ '+d.dups.length+' اسم مكرر بانتظار قرارك'}));
  if(d.failed.length){
    box.appendChild(el('div',{class:'errt',text:'⚠️ '+d.failed.length+' سطر لم يُضف (بقيت في الصندوق لتصحيحها):'}));
    d.failed.forEach(function(f){box.appendChild(el('div',{class:'errt small',text:f.line+'  ←  '+f.reason}));});
  }
  $('bulkText').value=d.failed.map(function(f){return f.line;}).join('\n');
  DRAFT[SEC]=$('bulkText').value;
  await refreshData();renderSecBar();
  if(d.dups.length)openDups(d.dups);
};
function openDups(dups){
  var checks=[],list=el('div');
  var all=el('input',{type:'checkbox'});all.checked=true;
  all.onchange=function(){checks.forEach(function(c){c.checked=all.checked;});};
  dups.forEach(function(d){
    var cb=el('input',{type:'checkbox'});cb.checked=true;checks.push(cb);
    var where=d.same?'مكرر داخل نفس القائمة':(d.sec?'موجود في الشعبة «'+d.sec+'»':'موجود بدون شعبة');
    list.appendChild(el('div',{class:'dup'},[
      el('label',{style:'display:flex;gap:8px;align-items:center;font-weight:700;flex-wrap:wrap'},[cb,d.name,el('span',{class:'tag',text:where})]),
      el('div',{text:'الدرجات الحالية: '+(d.old||'لا توجد')}),
      el('div',{text:'الدرجات الجديدة: '+d.nw}),
      el('div',{class:'small',style:'margin:0',text:d.over?'⚠️ التحديث سيستبدل درجات موجودة':'التحديث سيُكمل درجات غير موجودة فقط'})]));
  });
  var modal=el('div',{class:'modal'});
  var card=el('div',{class:'mcard',style:'max-width:640px'},[
    el('h3',{text:'أسماء مكررة'}),
    el('p',{class:'small',text:'هذه الأسماء موجودة مسبقاً فلم تُضف كطلاب جدد. حدد من تريد تحديث درجاته، والباقي يُتخطى.'}),
    el('label',{class:'chkl'},[all,'تحديد الكل']),
    list,
    el('div',{style:'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap'},[
      el('button',{class:'b-print',text:'تحديث المحدد',onclick:async function(){
        var items=[];
        dups.forEach(function(d,i){if(checks[i].checked)items.push({id:d.id,grades:d.grades});});
        if(!items.length){modal.remove();return;}
        var r=await api('/api/admin/students/apply','POST',{items:items},true);if(authFail(r))return;
        modal.remove();
        if(r.ok)toast('تم تحديث '+r.data.updated+' طالب');else alert(errMsg(r));
        await refreshData();renderSecBar();}}),
      el('button',{class:'b-gray',text:'تخطي الكل',onclick:function(){modal.remove();}})])]);
  modal.appendChild(card);document.body.appendChild(modal);
}

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
  else alert(errMsg(r));
}
$('btnSubjAdd').onclick=function(){
  var names=$('subjNew').value.split(/[\n,،]+/).map(function(x){return x.trim();}).filter(Boolean);
  if(!names.length)return;
  names.forEach(function(n){AD.settings.subjects.push({name:n,max:null});});
  $('subjNew').value='';saveSubj(true);
};

/* ---------- إدارة الطلاب ---------- */
function foldC(s){return String(s).replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').toLowerCase();}
function fillSecSel(){
  var sel=$('stSec'),old=sel.value||'*';sel.innerHTML='';
  sel.appendChild(el('option',{value:'*',text:'كل الشعب'}));
  secList().forEach(function(n){sel.appendChild(el('option',{value:n,text:'شعبة '+n+' ('+secCount(n)+')'}));});
  if(AD.students.some(function(s){return !s.sec;}))sel.appendChild(el('option',{value:'__none',text:'بدون شعبة'}));
  var has=false;for(var i=0;i<sel.options.length;i++)if(sel.options[i].value===old)has=true;
  sel.value=has?old:'*';
}
function gshow(v){return v==='غ'?'غائب':(v==='م'?'مؤجل':v);}
function renderStud(){
  var q=foldC($('stQ').value.trim()),fs=$('stSec').value,box=$('stList');box.innerHTML='';
  var subs=AD.settings.subjects;
  var list=AD.students.filter(function(s){
    if(q&&foldC(s.n).indexOf(q)<0)return false;
    if(fs==='*')return true;
    if(fs==='__none')return !s.sec;
    return foldC(s.sec||'')===foldC(fs);
  });
  $('stCount').textContent='(العدد: '+list.length+' من '+AD.students.length+')';
  if(!list.length)box.appendChild(el('p',{class:'small',text:'لا توجد نتائج.'}));
  list.slice(0,150).forEach(function(s){
    var sum=subs.map(function(sb){return s.g[sb.id]!==undefined?sb.name+': '+gshow(s.g[sb.id]):null;}).filter(Boolean).join(' | ');
    box.appendChild(el('div',{class:'srow'},[
      el('div',{class:'sname'},[s.n,s.sec?el('span',{class:'tag',text:s.sec}):null]),
      el('div',{class:'small',style:'margin:0',text:sum}),
      el('button',{class:'b-back sm',text:'تعديل',onclick:function(){editStudent(s);}}),
      el('button',{class:'b-red sm',text:'حذف',onclick:async function(){
        if(!confirm('حذف الطالب '+s.n+'؟'))return;
        var r=await api('/api/admin/students/'+s.id,'DELETE',undefined,true);if(authFail(r))return;
        if(r.ok){AD.students=AD.students.filter(function(x){return x.id!==s.id;});fillSecSel();renderStud();}}})]));
  });
  if(list.length>150)box.appendChild(el('p',{class:'small',text:'يظهر أول 150 فقط، استخدم البحث أو اختر شعبة للوصول لبقية الطلاب.'}));
}
$('stQ').oninput=renderStud;
$('stSec').onchange=renderStud;
$('btnClearAll').onclick=async function(){
  if(!confirm('سيتم حذف جميع الطلاب نهائياً. متابعة؟'))return;
  if(!confirm('تأكيد أخير: حذف كل الطلاب؟'))return;
  var r=await api('/api/admin/students/clear','POST',{},true);if(authFail(r))return;
  if(r.ok){AD.students=[];fillSecSel();renderStud();toast('تم الحذف');}
};
function editStudent(s){
  var subs=AD.settings.subjects;
  var name=el('input',{type:'text'});name.value=s.n;
  var sel=el('select');
  sel.appendChild(el('option',{value:'',text:'بدون شعبة'}));
  secList().forEach(function(n){var op=el('option',{value:n,text:n});if(foldC(s.sec||'')===foldC(n))op.selected=true;sel.appendChild(op);});
  var inputs={};
  var card=el('div',{class:'mcard'},[el('h3',{text:'تعديل الطالب'}),
    el('label',{class:'f',text:'الشعبة'}),sel,
    el('label',{class:'f',style:'margin-top:10px',text:'الاسم الثلاثي'}),name]);
  subs.forEach(function(sb){
    var i=el('input',{type:'text'});i.value=s.g[sb.id]!==undefined?s.g[sb.id]:'';inputs[sb.id]=i;
    card.appendChild(el('label',{class:'f',style:'margin-top:10px',text:sb.name}));card.appendChild(i);
  });
  card.appendChild(el('p',{class:'small',text:'اكتب رقماً، أو غ للغائب، أو م للمؤجل. اترك الخانة فارغة لعدم وجود درجة.'}));
  var modal=el('div',{class:'modal'},[card]);
  var err=el('p',{class:'errt hidden',style:'font-size:14px'});card.appendChild(err);
  card.appendChild(el('div',{style:'display:flex;gap:8px;margin-top:14px'},[
    el('button',{class:'b-print',text:'حفظ',onclick:async function(){
      var g={};for(var id in inputs)g[id]=inputs[id].value;
      var r=await api('/api/admin/students/'+s.id,'PUT',{name:name.value,sec:sel.value,g:g},true);if(authFail(r))return;
      if(r.ok){s.n=r.data.student.n;s.sec=r.data.student.sec;s.g=r.data.student.g;modal.remove();fillSecSel();renderStud();toast('تم الحفظ');}
      else{err.textContent=errMsg(r);err.classList.remove('hidden');}}}),
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
  if(r.ok){AD.settings=r.data.settings;C.s=Object.assign({},r.data.settings);delete C.s.subjects;delete C.s.sections;applySettings();toast(msg||'تم الحفظ');}
  else alert(r.data.error==='server_error'?errMsg(r):(r.data.error||'تعذر الحفظ (قد تكون الصورة كبيرة)'));
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
  var sel=el('select',{style:'max-width:280px'});
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
    el('p',{class:'small',text:'تظهر الدرجة بالأحمر إذا كانت أقل من هذه النسبة من درجة الامتحان (أو كانت غياب). اكتب 0 لإلغاء التلوين.'}),
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

/* ---------- التحقق من القناة (تطبيق تيليجرام) ---------- */
var DEVCACHE=null;
function devOk(v){return /^[a-f0-9]{24}$/.test(v||'');}
function tgStore(name,op,key,val){return new Promise(function(res){
  var fin=false,t=setTimeout(function(){if(!fin){fin=true;res('');}},1500);
  function done(v){if(fin)return;fin=true;clearTimeout(t);res(v||'');}
  try{
    var S=TG&&TG[name];
    if(!S||!TG.isVersionAtLeast||!TG.isVersionAtLeast('9.0')){done('');return;}
    if(op==='get')S.getItem(key,function(err,v){done(err?'':v);});
    else S.setItem(key,val,function(){done('');});
  }catch(e){done('');}
});}
async function devId(){
  if(DEVCACHE)return DEVCACHE;
  var ls='',ck='';
  try{ls=localStorage.getItem('dv')||'';}catch(e){}
  var m=document.cookie.match(/(?:^|; )dv=([a-f0-9]{24})/);ck=m?m[1]:'';
  var r=await Promise.all([tgStore('SecureStorage','get','dv'),tgStore('DeviceStorage','get','dv')]);
  var list=[];
  [r[0],r[1],ls,ck].forEach(function(v){if(devOk(v)&&list.indexOf(v)<0)list.push(v);});
  if(!list.length){
    var a=new Uint8Array(12);crypto.getRandomValues(a);
    list.push(Array.prototype.map.call(a,function(x){return ('0'+x.toString(16)).slice(-2);}).join(''));
  }
  var p=list[0];
  if(!devOk(ls)){try{localStorage.setItem('dv',p);}catch(e){}}
  if(!devOk(ck)){try{document.cookie='dv='+p+';max-age=315360000;path=/;SameSite=None;Secure';}catch(e){}}
  var w=[];
  if(!devOk(r[0]))w.push(tgStore('SecureStorage','set','dv',p));
  if(!devOk(r[1]))w.push(tgStore('DeviceStorage','set','dv',p));
  await Promise.all(w);
  DEVCACHE=list.slice(0,4);
  return DEVCACHE;
}
function gateSvg(k){
  if(k==='verify')return '<svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="52"/><circle class="arc" cx="60" cy="60" r="52"/><path class="shd" d="M60 34l19 7.5v14c0 12.5-8 22-19 26.5-11-4.5-19-14-19-26.5v-14z"/></svg>';
  if(k==='ok')return '<svg viewBox="0 0 120 120"><circle class="okring" cx="60" cy="60" r="50"/><circle class="okbg" cx="60" cy="60" r="46"/><path class="okchk" d="M38 62l16 16 30-34"/></svg>';
  if(k==='bad')return '<svg viewBox="0 0 120 120"><circle class="rbg" cx="60" cy="60" r="50"/><rect class="rlkb" x="38" y="55" width="44" height="34" rx="9"/><path class="rlks" d="M46 55V46a14 14 0 0 1 28 0v9"/><circle class="rdot" cx="60" cy="73" r="5"/><path class="rlkl" d="M60 73v8"/></svg>';
  if(k==='warn')return '<svg viewBox="0 0 120 120"><circle class="rbg" cx="60" cy="60" r="50"/><path class="rx" d="M38 60a22 22 0 1 1 44 0 22 22 0 0 1-44 0"/><path class="rx" d="M44 44l32 32"/></svg>';
  return '<svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="52"/><rect class="lkb" x="40" y="56" width="40" height="32" rx="7"/><path class="lks" d="M47 56V47a13 13 0 0 1 26 0v9"/></svg>';
}
function gbtn(txt,cls,fn){return el('button',{class:cls+' gb',text:txt,onclick:fn});}
function showGate(kind,d){
  var box=$('gateBox');box.innerHTML='';
  var red=false,okc=false,svg='',title='',sub='',pc='#22c55e',btns=[],chip='';
  var ch=(d&&d.channel)||null;
  var chT=ch?ch.title:((C&&C.ch)||'');
  var retry=function(){startApp();};
  if(kind==='verify'){svg=gateSvg('verify');title='يتم التحقق...';sub='نتأكد من انضمامك إلى القناة';}
  else if(kind==='ok'){okc=true;svg=gateSvg('ok');title='تم التحقق';sub='أهلاً بك، تفضّل بالدخول';}
  else if(kind==='done'){red=true;pc='#dc2626';svg=gateSvg('bad');title='انتهت المحاولات';sub='لقد استُخدمت المحاولة الوحيدة المتاحة لهذا الجهاز.';}
  else if(kind==='notmember'){
    red=true;pc='#e53935';svg=gateSvg('warn');title='أنت غير موجود في القناة';
    sub='للدخول يجب أن تكون مشتركاً في القناة التالية:';chip=chT;
    if(ch&&ch.url)btns.push(gbtn('الانضمام إلى القناة','b-back',function(){if(TG&&TG.openTelegramLink)TG.openTelegramLink(ch.url);else window.open(ch.url,'_blank');}));
    btns.push(gbtn('إعادة التحقق','b-gray',retry));
  }
  else if(kind==='nochannel'){svg=gateSvg('lock');title='التطبيق غير جاهز بعد';sub='لم يتم ربط القناة بعد، حاول لاحقاً.'+(ISADMIN?' (أنت المشرف: أضف البوت مشرفاً في القناة أو اضبطها من البوت)':'');}
  else if(kind==='chanerror'){svg=gateSvg('lock');title='تعذر التحقق من القناة';sub='حدثت مشكلة مؤقتة في التحقق، حاول بعد قليل.';btns.push(gbtn('إعادة المحاولة','b-back',retry));}
  else if(kind==='expired'){svg=gateSvg('lock');title='انتهت صلاحية الجلسة';sub='أغلق التطبيق وافتحه من القناة من جديد.';}
  else if(kind==='error'){svg=gateSvg('lock');title='تعذر الاتصال بالخادم';sub='تأكد من الإنترنت وحاول مرة أخرى.';btns.push(gbtn('إعادة المحاولة','b-back',retry));}
  else{svg=gateSvg('lock');title='افتح الموقع من القناة';sub='هذا الموقع يعمل فقط من داخل تيليجرام، عبر الزر المنشور في قناة المدرس.';chip=chT;}
  var card=el('div',{class:'gcard'+(red?' red':'')+(okc?' okc':'')});
  var ring=el('div',{class:'gring'});ring.innerHTML=svg;
  if(okc||red){
    for(var i=0;i<10;i++){var p=el('span',{class:'pt'});p.style.setProperty('--a',(i*36)+'deg');p.style.setProperty('--pc',pc);ring.appendChild(p);}
  }
  card.appendChild(ring);
  card.appendChild(el('div',{class:'gt',text:title}));
  card.appendChild(el('div',{class:'gs',text:sub}));
  if(chip)card.appendChild(el('div',{class:'gchip',text:chip}));
  if(btns.length){var bb=el('div',{class:'gbtns'});btns.forEach(function(b){bb.appendChild(b);});card.appendChild(bb);}
  box.appendChild(card);
  show('viewGate');
}
async function startApp(){
  if(!INIT){showGate('browser');return;}
  try{TG.ready();TG.expand();}catch(e){}
  showGate('verify');
  var t0=Date.now();
  var r=await api('/api/tg/status','POST',{init:INIT,devs:await devId()});
  var w=1700-(Date.now()-t0);if(w>0)await sleep(w);
  if(r.status===0||r.status>=500){showGate('error');return;}
  if(r.status===401){showGate('expired');return;}
  var d=r.data||{};
  ISADMIN=!!d.admin;
  if(d.state==='ready'){showGate('ok');await sleep(1900);show('viewSearch');}
  else showGate(d.state||'error',d);
}

/* ---------- المحاولات (لوحة التحكم) ---------- */
var ATT=null;
async function renderAtt(){
  var r=await api('/api/admin/attempts','GET',undefined,true);if(authFail(r))return;
  if(!r.ok){toast('تعذر التحميل');return;}
  ATT=r.data;
  var info=$('attInfo');info.innerHTML='';
  info.appendChild(el('h2',{text:'القناة والتطبيق'}));
  info.appendChild(el('p',{class:ATT.channel?'ok':'errt',text:ATT.channel?('القناة: '+ATT.channel.title+' ✅'):'القناة غير مضبوطة ⚠️'}));
  info.appendChild(el('p',{class:ATT.applink?'ok':'errt',text:ATT.applink?('رابط التطبيق: '+ATT.applink):'رابط التطبيق غير مضبوط ⚠️'}));
  info.appendChild(el('p',{class:'small',text:'تُضبط القناة والرابط من البوت (أزرار: ضبط القناة، رابط التطبيق، نشر في القناة).'}));
  drawAtt();
}
function drawAtt(){
  var box=$('attList');box.innerHTML='';
  if(!ATT)return;
  var q=foldC($('attQ').value.trim());
  var list=ATT.items.filter(function(x){
    if(!q)return true;
    return foldC([x.fn,x.un,x.n,x.uid].join(' ')).indexOf(q)>=0;
  });
  $('attCount').textContent='(العدد: '+list.length+' من '+ATT.items.length+')';
  if(!list.length)box.appendChild(el('p',{class:'small',text:'لا توجد محاولات مسجلة.'}));
  list.slice(0,200).forEach(function(x){
    var who=(x.fn||'بدون اسم')+(x.un?' @'+x.un:'');
    var when='';try{when=new Date(x.t).toLocaleString('ar');}catch(e){}
    box.appendChild(el('div',{class:'srow'},[
      el('div',{class:'sname',text:who}),
      el('div',{class:'small',style:'margin:0',text:'الطالب: '+(x.n||'-')+'  |  '+when+'  |  المعرّف: '+x.uid}),
      el('button',{class:'b-back sm',text:'إعادة المحاولة',onclick:async function(){
        if(!confirm('السماح لهذا الحساب وجهازه بمحاولة جديدة؟'))return;
        var r=await api('/api/admin/attempts/reset','POST',{uid:x.uid},true);if(authFail(r))return;
        if(r.ok){ATT.items=ATT.items.filter(function(y){return y.uid!==x.uid;});drawAtt();toast('تمت إعادة المحاولة');}}})]));
  });
  if(list.length>200)box.appendChild(el('p',{class:'small',text:'يظهر أول 200 فقط، استخدم البحث.'}));
}
$('attQ').oninput=drawAtt;


/* ---------- البداية ---------- */
(async function(){
  if(INIT)showGate('verify');
  try{
    if(C)applySettings();
    await loadConfig();
  }catch(e){}
  if(TOKEN){
    var r=await api('/api/admin/ping','GET',undefined,true);
    if(r.ok){
      ADMIN_OK=true;applySettings();
      if(location.search.indexOf('admin=1')>=0){try{history.replaceState(null,'','/');}catch(e){}loadAdmin(true);return;}
    }else if(r.status===401){TOKEN='';setTok('');}
  }
  startApp();
})();
</script>
</body>
</html>`;
