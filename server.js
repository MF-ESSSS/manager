// Локальный сервер: входит в Steam и отдаёт статус, уровень, баланс и аватар.
const path = require('path');
const express = require('express');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const { fetch, ProxyAgent } = require('undici');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function describe(e) {
  const name = e && e.eresult !== undefined ? SteamUser.EResult[e.eresult] : null;
  const map = {
    InvalidPassword: 'Неверный пароль или логин',
    RateLimitExceeded: 'Steam ограничил вход (слишком много попыток). Подождите и повторите',
    AccountLoginDeniedThrottle: 'Steam ограничил вход. Подождите и повторите',
    TwoFactorCodeMismatch: 'Неверный код Steam Guard (проверьте время на компьютере и maFile)',
    AccountLoginDeniedNeedTwoFactor: 'Нужен код Steam Guard: загрузите maFile',
    InvalidLoginAuthCode: 'Неверный код подтверждения'
  };
  return map[name] || ('Ошибка Steam: ' + (name || (e && e.message) || 'неизвестная'));
}

function steamLogin({ login, password, sharedSecret, proxy }) {
  return new Promise((resolve, reject) => {
    const opts = { autoRelogin: false };
    if (proxy) opts.httpProxy = proxy;
    const client = new SteamUser(opts);
    let steamId = null, done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { client.logOff(); } catch (e) {} reject(err); } else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Таймаут входа (45 с)')), 45000);
    client.on('error', (e) => finish(new Error(describe(e))));
    client.on('loggedOn', () => { steamId = client.steamID.getSteamID64(); });
    client.on('webSession', (sid, cookies) => finish(null, { client, steamId, cookies }));
    const details = { accountName: login, password };
    if (sharedSecret) details.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
    client.logOn(details);
  });
}

async function getText(url, cookies, proxy) {
  const opt = { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9', Cookie: cookies.join('; ') } };
  if (proxy) opt.dispatcher = new ProxyAgent(proxy);
  const r = await fetch(url, opt);
  return r.text();
}

const decode = (s) => s.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, ' ').trim();

app.post('/api/refresh', async (req, res) => {
  const { login, password, sharedSecret, proxy } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Нет логина или пароля' });
  if (proxy && !/^https?:\/\//i.test(proxy)) {
    return res.status(400).json({ error: 'Поддерживаются только http/https прокси (socks пока нет)' });
  }
  let session;
  try {
    session = await steamLogin({ login, password, sharedSecret, proxy });
    const { client, steamId, cookies } = session;
    const [store, xml, page] = await Promise.all([
      getText('https://store.steampowered.com/account/', cookies, proxy),
      getText(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, cookies, proxy),
      getText(`https://steamcommunity.com/profiles/${steamId}/`, cookies, proxy)
    ]);
    const m = (re, s) => { const x = s.match(re); return x ? decode(x[1]) : null; };
    res.json({
      steamId,
      status: 'Онлайн',
      name: m(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/, xml),
      avatar: m(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/, xml),
      level: Number(m(/friendPlayerLevelNum">(\d+)</, page)) || 0,
      wallet: m(/id="header_wallet_balance"[^>]*>([^<]+)</, store)
    });
    try { client.logOff(); } catch (e) {}
  } catch (e) {
    res.status(502).json({ error: e.message || 'Ошибка обновления' });
  }
});

// '0.0.0.0' — обязательно для хостингов вроде Railway/Render, которые
// пробрасывают трафик снаружи; для запуска строго на своём ПК это тоже безопасно,
// т.к. порт наружу видно только если вы сами открыли его в роутере/фаерволе.
app.listen(PORT, '0.0.0.0', () => console.log('Steam Manager listening on port ' + PORT));
