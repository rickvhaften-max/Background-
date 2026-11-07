// LLTE Roblox Background Check Discord command (Cloudflare Workers Free).
// The Worker receives Discord slash command interactions; no persistent bot process is needed.
const DAPI = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const escapeText = (v, max = 100) => String(v ?? 'Unknown').replaceAll('@', '@\u200b').replace(/[`*_~|<>]/g, '').replace(/[\r\n]/g, ' ').slice(0, max);
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' }}); }
function unhex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Invalid signature/key');
  return new Uint8Array(hex.match(/../g).map(v => parseInt(v, 16)));
}
async function verifyDiscord(request, rawBody, env) {
  const signature = request.headers.get('X-Signature-Ed25519') || '';
  const timestamp = request.headers.get('X-Signature-Timestamp') || '';
  if (!/^[a-f0-9]{128}$/i.test(signature) || !/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '') || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey('raw', unhex(env.DISCORD_PUBLIC_KEY), {name: 'Ed25519'}, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, unhex(signature), new TextEncoder().encode(timestamp + rawBody));
  } catch { return false; }
}
function isStaff(interaction, env) {
  if (!interaction.guild_id || (env.DISCORD_GUILD_ID && interaction.guild_id !== env.DISCORD_GUILD_ID) || !interaction.member) return false;
  let p = 0n;
  try { p = BigInt(interaction.member.permissions || 0); } catch { /* leave */ }
  const hasPerm = (p & ((1n << 3n) | (1n << 5n))) !== 0n; // Administrator / Manage Server
  const allowedRoles = (env.STAFF_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return hasPerm || allowedRoles.some(role => (interaction.member.roles || []).includes(role));
}
async function roblox(url, payload) {
  const response = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? {'content-type': 'application/json', 'accept': 'application/json'} : {'accept': 'application/json'},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (response.status === 429) throw Error('Roblox rate limited this check; retry later.');
  if (!response.ok) throw Error(`Roblox API returned HTTP ${response.status}`);
  return response.json();
}
async function sendFollowup(i, embed) {
  const url = `${DAPI}/webhooks/${encodeURIComponent(i.application_id)}/${encodeURIComponent(i.token)}`;
  const r = await fetch(url, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({flags: EPHEMERAL, allowed_mentions: {parse: []}, embeds: [embed]}),
  });
  if (!r.ok) console.error('Discord follow-up error:', r.status);
}
const textField = (name, value, inline = false) => ({name, value: String(value).slice(0, 1024) || 'Unavailable', inline});
function failure(message) {return {title: '🔎 LLTE | Roblox Background Check', color: 0xD08041, description: escapeText(message, 500)};}
async function backgroundCheck(interaction, username) {
  try {
    const lookup = await roblox('https://users.roblox.com/v1/usernames/users', {usernames: [username], excludeBannedUsers: false});
    const entry = lookup?.data?.[0];
    if (!entry?.id) return sendFollowup(interaction, failure(`Roblox account not found: ${username}`));
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id < 1) throw Error('Invalid Roblox ID');
    const result = await Promise.allSettled([
      roblox(`https://users.roblox.com/v1/users/${id}`),
      roblox(`https://users.roblox.com/v1/users/${id}/username-history?limit=10&sortOrder=Desc`),
      roblox(`https://groups.roblox.com/v1/users/${id}/groups/roles`),
      roblox(`https://friends.roblox.com/v1/users/${id}/friends/count`),
      roblox(`https://friends.roblox.com/v1/users/${id}/followers/count`),
      roblox(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`),
    ]);
    const data = result.map(x => x.status === 'fulfilled' ? x.value : null);
    const [profile, history, groups, friends, followers, thumbnail] = data;
    const created = profile?.created ? new Date(profile.created) : null;
    const createdValid = created && !isNaN(created.getTime());
    const ageDays = createdValid ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000)) : null;
    const dateText = createdValid ? `${ageDays} days (<t:${Math.floor(created.getTime()/1000)}:D>)` : 'Unavailable';
    const pastNames = Array.isArray(history?.data) ? (history.data.length ? history.data.map(x => escapeText(x.name, 35)).join(', ') : 'None returned') : 'Unavailable';
    const fields = [
      textField('Name', escapeText(profile?.name || entry.name, 70)),
      textField('ID', String(id), true),
      textField('Profile URL', `[Open Roblox Profile](https://www.roblox.com/users/${id}/profile)`),
      textField('Past Names', pastNames),
      textField('Premium', 'Not publicly verified'),
      textField('Verified LLTE', 'Not linked — Roblox ownership must be verified separately'),
      textField('Statistics', `• Friends: ${typeof friends?.count === 'number' ? friends.count : 'Unavailable'}\n• Followers: ${typeof followers?.count === 'number' ? followers.count : 'Unavailable'}\n• Age: ${dateText}`),
      textField('Game Banned', 'Not checked — requires LLTE game records'),
      textField('Community Banned', 'Not checked — requires LLTE staff records'),
      textField('Blacklists', 'Not checked — no shared blacklist connected'),
      textField('Status', 'Public profile check complete; staff review required'),
    ];
    if (Array.isArray(groups?.data)) {
      const items = groups.data.slice(0, 18).map(a => `• ${escapeText(a.group?.name, 38)} — ${escapeText(a.role?.name, 32)}`);
      let block = '';
      let page = 1;
      for (const item of items) {
        if (block && block.length + item.length + 1 > 850) {fields.push(textField(`Public Groups (${page++})`, block)); block = '';}
        block += (block ? '\n' : '') + item;
      }
      fields.push(textField('Public Groups' + (page > 1 ? ` (${page})` : ''), block || 'None returned'));
      if (groups.data.length > 18) fields.push(textField('Additional Groups', `${groups.data.length - 18} more not shown`));
    } else fields.push(textField('Public Groups', 'Unavailable from Roblox API'));
    const embed = {
      title: `Background Check | ${escapeText(profile?.name || username, 45)}`,
      url: `https://www.roblox.com/users/${id}/profile`,
      description: '🛡️ LLTE Imperial Command · Automatic public Roblox information',
      color: 0x477CB5,
      fields: fields.slice(0, 25), timestamp: new Date().toISOString(),
      footer: {text: 'Staff only • This does not prove account ownership or determine trustworthiness'},
    };
    const img = thumbnail?.data?.[0]?.imageUrl;
    if (typeof img === 'string' && img.startsWith('https://')) embed.thumbnail = {url: img};
    await sendFollowup(interaction, embed);
  } catch (e) { console.error('Background check failure:', String(e)); await sendFollowup(interaction, failure(e?.message || 'Background check unavailable')); }
}
async function registerSlashCommand(env) {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return json({error: 'Set DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN first.'}, 400);
  const cmd = {name: 'bgcheck', description: 'Automatically check public Roblox account information (LLTE staff only)', type: 1,
    options: [{name: 'username', description: 'Exact Roblox username (not display name)', type: 3, required: true, min_length: 3, max_length: 20}], dm_permission: false};
  const response = await fetch(`${DAPI}/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`, {method: 'POST', headers: {'authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify(cmd)});
  if (!response.ok) return json({error: 'Registration failed; check application ID, guild ID, bot invite and token', discordStatus: response.status}, 400);
  return json({registered: true, command: '/bgcheck username', message: 'You can now remove DISCORD_BOT_TOKEN and SETUP_KEY from Worker secrets if you will not register again.'});
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({service: 'LLTE Roblox Background Check', status: 'ready', command: '/bgcheck', needsManualRestart: false});
    if (url.pathname === '/register' && request.method === 'GET') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return json({error: 'Not authorized'}, 403);
      return registerSlashCommand(env);
    }
    if (url.pathname !== '/interactions' || request.method !== 'POST') return json({error: 'Not found'}, 404);
    const body = await request.text();
    if (!await verifyDiscord(request, body, env)) return json({error: 'Invalid Discord signature'}, 401);
    let i; try {i = JSON.parse(body);} catch {return json({error: 'Invalid payload'}, 400);}
    if (i.type === 1) return json({type: 1}); // Discord PING
    if (i.type !== 2 || i.data?.name !== 'bgcheck') return json({type: 4, data: {flags: EPHEMERAL, content: 'Unknown command'}});
    
    const username = String(i.data?.options?.find(v => v.name === 'username')?.value || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return json({type: 4, data: {flags: EPHEMERAL, content: 'Please enter an exact valid Roblox username.'}});
    ctx.waitUntil(backgroundCheck(i, username));
    return json({type: 5, data: {flags: EPHEMERAL}}); // deferred, private to requesting staff member
  },
};
// LLTE deploy test

