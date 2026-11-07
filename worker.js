
// LLTE Roblox Background Check — Cloudflare Workers Free
// Public Discord slash command, public results, cached Roblox API calls.
const DAPI = 'https://discord.com/api/v10';
const CACHE_TTL = 300;
const TIMEOUT_MS = 7000;
const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});
}
function clean(value, max = 100) {
  return String(value ?? 'Unknown').replace(/@/g, '@\u200b').replace(/[`*_~|<>\\]/g, '').replace(/[\r\n]/g, ' ').slice(0, max);
}
function unhex(hex) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw Error('Invalid hex');
  return Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
}
async function verifyDiscord(request, raw, env) {
  const sig = request.headers.get('X-Signature-Ed25519') || '';
  const time = request.headers.get('X-Signature-Timestamp') || '';
  if (!/^[a-f0-9]{128}$/i.test(sig) || !/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '') || !/^\d+$/.test(time)) return false;
  if (Math.abs(Date.now() - Number(time) * 1000) > 300000) return false;
  try {
    const key = await crypto.subtle.importKey('raw', unhex(env.DISCORD_PUBLIC_KEY), {name: 'Ed25519'}, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, unhex(sig), enc.encode(time + raw));
  } catch { return false; }
}
function cacheKey(url, payload) {
  const encoded = payload ? encodeURIComponent(JSON.stringify(payload)) : '';
  return new Request('https://llte-cache.invalid/' + encodeURIComponent(url) + (encoded ? '?body=' + encoded : ''));
}
async function roblox(url, payload, ttl = CACHE_TTL) {
  const key = cacheKey(url, payload);
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) return cached.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: payload ? 'POST' : 'GET',
      headers: {'accept': 'application/json', ...(payload ? {'content-type': 'application/json'} : {})},
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw Error('Roblox is taking too long. Please try again.');
    throw Error('Roblox is temporarily unreachable.');
  } finally { clearTimeout(timer); }
  if (response.status === 429) throw Error('Roblox is rate limiting requests. Please try again in a few minutes.');
  if (!response.ok) throw Error(`Roblox API error (HTTP ${response.status}).`);
  const data = await response.json();
  // Cache only successful responses. The Workers cache is per data center.
  if (ttl > 0) {
    await cache.put(key, new Response(JSON.stringify(data), {
      headers: {'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}`},
    }));
  }
  return data;
}
async function editOriginal(interaction, embed) {
  const url = `${DAPI}/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`;
  const response = await fetch(url, {
    method: 'PATCH', headers: {'content-type': 'application/json'},
    body: JSON.stringify({embeds: [embed], allowed_mentions: {parse: []}}),
  });
  if (!response.ok) console.error('Discord edit failed', response.status, (await response.text()).slice(0, 300));
}
function field(name, value, inline = false) {
  return {name, value: String(value || 'Unavailable').slice(0, 1024), inline};
}
function failure(message) {
  return {title: 'LLTE | Roblox Background Check', description: clean(message, 500), color: 0xD08041};
}
async function optional(url, ttl) {
  try {return await roblox(url, null, ttl);} catch (e) {console.log('Optional Roblox request unavailable:', url, String(e)); return null;}
}
async function backgroundCheck(interaction, username) {
  try {
    const lookup = await roblox('https://users.roblox.com/v1/usernames/users', {usernames: [username], excludeBannedUsers: false}, 600);
    const entry = lookup?.data?.[0];
    if (!entry?.id) return editOriginal(interaction, failure(`Roblox account not found: ${username}`));
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id < 1) throw Error('Invalid Roblox account ID.');
    // Only one essential profile request; optional requests are isolated.
    const profile = await roblox(`https://users.roblox.com/v1/users/${id}`, null, 300);
    const [groups, friends, thumbnail] = await Promise.all([
      optional(`https://groups.roblox.com/v1/users/${id}/groups/roles`, 600),
      optional(`https://friends.roblox.com/v1/users/${id}/friends/count`, 300),
      optional(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`, 900),
    ]);
    const created = profile?.created ? new Date(profile.created) : null;
    const validCreated = created && !Number.isNaN(created.getTime());
    const ageDays = validCreated ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000)) : null;
    const fields = [
      field('Username', clean(profile?.name || entry.name, 70), true),
      field('Display name', clean(profile?.displayName || entry.displayName, 70), true),
      field('Roblox ID', String(id), true),
      field('Account age', validCreated ? `${ageDays} days (<t:${Math.floor(created.getTime() / 1000)}:D>)` : 'Unavailable', true),
      field('Friends', typeof friends?.count === 'number' ? String(friends.count) : 'Unavailable', true),
      field('Roblox banned', typeof profile?.isBanned === 'boolean' ? (profile.isBanned ? 'Yes (Roblox profile flag)' : 'No (Roblox profile flag)') : 'Unavailable', true),
      field('LLTE account verification', 'Not checked — account ownership not verified'),
      field('LLTE bans / blacklists', 'Not checked — no LLTE moderation records connected'),
    ];
    if (Array.isArray(groups?.data)) {
      const list = groups.data.slice(0, 12).map(x => `• ${clean(x.group?.name, 42)} — ${clean(x.role?.name, 30)}`);
      const value = list.join('\n').slice(0, 950) || 'No public groups returned';
      fields.push(field('Public groups', value));
      if (groups.data.length > 12) fields.push(field('Other groups', `${groups.data.length - 12} additional groups not shown`));
    } else fields.push(field('Public groups', 'Unavailable'));
    const embed = {
      title: `LLTE Background Check | ${clean(profile?.name || username, 45)}`,
      url: `https://www.roblox.com/users/${id}/profile`,
      description: 'Public Roblox account information • Not proof of identity or trustworthiness',
      color: 0x477CB5, fields: fields.slice(0, 25), timestamp: new Date().toISOString(),
      footer: {text: 'LLTE • Public check • Roblox may temporarily limit API requests'},
    };
    const img = thumbnail?.data?.[0]?.imageUrl;
    if (typeof img === 'string' && img.startsWith('https://')) embed.thumbnail = {url: img};
    await editOriginal(interaction, embed);
  } catch (e) {
    console.error('Background check failed', String(e));
    await editOriginal(interaction, failure(e?.message || 'Background check unavailable.'));
  }
}
async function registerSlashCommand(env) {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return json({error: 'Missing DISCORD_APPLICATION_ID, DISCORD_GUILD_ID or DISCORD_BOT_TOKEN'}, 400);
  const cmd = {
    name: 'bgcheck', type: 1,
    description: 'Check public Roblox account information (available to everyone)',
    options: [{name: 'username', description: 'Exact Roblox username (not display name)', type: 3, required: true, min_length: 3, max_length: 20}],
  };
  // POST updates an existing guild command with the same name.
  const response = await fetch(`${DAPI}/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`, {
    method: 'POST', headers: {'authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify(cmd),
  });
  if (!response.ok) return json({error: 'Discord registration failed', discordStatus: response.status}, 400);
  return json({registered: true, command: '/bgcheck username', visibility: 'public', permission: 'everyone'});
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') return json({service: 'LLTE Roblox Background Check', status: 'ready', command: '/bgcheck', publicResults: true});
    if (url.pathname === '/register' && request.method === 'GET') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return json({error: 'Not authorized'}, 403);
      return registerSlashCommand(env);
    }
    if (url.pathname !== '/interactions' || request.method !== 'POST') return json({error: 'Not found'}, 404);
    const raw = await request.text();
    if (!await verifyDiscord(request, raw, env)) return json({error: 'Invalid Discord signature'}, 401);
    let interaction;
    try {interaction = JSON.parse(raw);} catch {return json({error: 'Invalid JSON'}, 400);}
    if (interaction.type === 1) return json({type: 1});
    if (interaction.type !== 2 || interaction.data?.name !== 'bgcheck') return json({type: 4, data: {content: 'Unknown command'}});
    if (env.DISCORD_GUILD_ID && interaction.guild_id !== env.DISCORD_GUILD_ID) return json({type: 4, data: {content: 'This command is only available in the LLTE server.', flags: 64}});
    const username = String(interaction.data?.options?.find(x => x.name === 'username')?.value || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return json({type: 4, data: {content: 'Enter a valid Roblox username.', flags: 64}});
    ctx.waitUntil(backgroundCheck(interaction, username));
    return json({type: 5}); // Public deferred response; PATCH @original when finished.
  },
};
