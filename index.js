// HIGH-SPEED CONNECTION — Discord community management bot
// - Channel indexer + camera policy + High-Speed Connection VC events
// - OAuth2 dashboard (Discord login) — users see only their own guilds
// - Storage: MongoDB Atlas (replaces local JSON files for Render.com compatibility)

require('dotenv').config();
const path   = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ===========================================================================
//  MONGODB CONNECTION
// ===========================================================================
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('Missing MONGODB_URI env var'); process.exit(1); }

const mongoClient = new MongoClient(MONGODB_URI);
let db;

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db('hsc_bot');
  console.log('[startup] MongoDB connected');
}

// ---------------------------------------------------------------------------
//  Generic helpers — every config collection is keyed by { _id: 'data' }
//  for single-document collections (camera, speed-match, etc.) or
//  { _id: guildId } for per-guild sub-documents inside a shared collection.
//  We use simple upsert so there is no "create first" step needed.
// ---------------------------------------------------------------------------
async function dbGet(collection) {
  try {
    const doc = await db.collection(collection).findOne({ _id: 'data' });
    return doc ? doc.value : null;
  } catch (err) { console.error(`[db] get ${collection}:`, err.message); return null; }
}
async function dbSet(collection, value) {
  try {
    await db.collection(collection).replaceOne({ _id: 'data' }, { _id: 'data', value }, { upsert: true });
    return true;
  } catch (err) { console.error(`[db] set ${collection}:`, err.message); return false; }
}

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const TOKEN    = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN || !GUILD_ID) { console.error('Missing DISCORD_TOKEN or GUILD_ID'); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

// ===========================================================================
//  CAMERA POLICY CONFIG  (in-memory cache + MongoDB persistence)
// ===========================================================================
const DEFAULT_GRACE_MINUTES   = 2;
const DEFAULT_WARNING_MINUTES = 3;

let cameraConfig = {};

async function loadCameraConfig() {
  const val = await dbGet('camera_config');
  cameraConfig = val || {};
  for (const [gid, cfg] of Object.entries(cameraConfig)) {
    console.log(`[startup] camera-config guild=${gid} enabled=${cfg.enabled} monitoredChannels=${cfg.monitoredChannels?.length ?? 0}`);
  }
  if (Object.keys(cameraConfig).length === 0) console.warn('[startup] camera_config is empty in MongoDB');
}
async function saveCameraConfig(config) {
  cameraConfig = config;
  const ok = await dbSet('camera_config', config);
  if (ok) console.log('[camera] Config saved to MongoDB');
  else console.error('[camera] FAILED to save config to MongoDB');
  return ok;
}

function ensureGuildConfig(guildId) {
  if (!cameraConfig[guildId]) {
    cameraConfig[guildId] = {
      enabled: false,
      monitoredChannels: [],
      monitoredCategoryIds: [],
      exemptRoles: [],
      graceMinutes: DEFAULT_GRACE_MINUTES,
      warningMinutes: DEFAULT_WARNING_MINUTES,
      announcementUrl: null,
      announcementChannelId: null,
    };
  }
  const c = cameraConfig[guildId];
  if (c.announcementChannelId === undefined) c.announcementChannelId = null;
  if (c.monitoredCategoryIds  === undefined) c.monitoredCategoryIds  = [];
  return c;
}

function isCameraPolicyEnabled(guildId)      { return ensureGuildConfig(guildId).enabled !== false; }
async function setCameraPolicyEnabled(guildId, en) { ensureGuildConfig(guildId).enabled = en; return saveCameraConfig(cameraConfig); }
function getExemptRoles(guildId)             { return ensureGuildConfig(guildId).exemptRoles; }
function getTiming(guildId) {
  const c = ensureGuildConfig(guildId);
  return { graceMinutes: c.graceMinutes ?? DEFAULT_GRACE_MINUTES, warningMinutes: c.warningMinutes ?? DEFAULT_WARNING_MINUTES };
}
function getAnnouncementUrl(guildId) { return ensureGuildConfig(guildId).announcementUrl || null; }

function getEffectiveMonitoredChannelIds(guildId, guild) {
  const cfg = ensureGuildConfig(guildId);
  const ids = new Set(cfg.monitoredChannels);
  if (guild && cfg.monitoredCategoryIds?.length) {
    for (const ch of guild.channels.cache.values()) {
      if (ch.parentId && cfg.monitoredCategoryIds.includes(ch.parentId) &&
          (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)) {
        ids.add(ch.id);
      }
    }
  }
  return ids;
}

// ===========================================================================
//  CAMERA ENFORCEMENT
// ===========================================================================
const warnedUsers = new Map();

function warnKey(guildId, userId) { return `${guildId}:${userId}`; }
function announcementLine(guildId) {
  const url = getAnnouncementUrl(guildId);
  return url ? `\n🔗 Policy details: <${url}>` : '';
}
function clearAllCameraWarningsForGuild(guildId) {
  for (const [key, info] of warnedUsers.entries()) {
    if (!key.startsWith(`${guildId}:`)) continue;
    if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
    if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
    warnedUsers.delete(key);
  }
}

async function handleCameraOff(member, channel) {
  const guildId = member.guild.id;
  const key = warnKey(guildId, member.id);
  if (warnedUsers.has(key)) return;

  const { graceMinutes, warningMinutes } = getTiming(guildId);
  const graceMs = graceMinutes * 60 * 1000;
  const warnMs  = warningMinutes * 60 * 1000;

  const graceTimeoutId = setTimeout(async () => {
    try {
      if (!isCameraPolicyEnabled(guildId)) { warnedUsers.delete(key); return; }
      const cvc = member.voice?.channel;
      const stillIn = cvc && getEffectiveMonitoredChannelIds(guildId, member.guild).has(cvc.id);
      if (!stillIn || member.voice.selfVideo) { warnedUsers.delete(key); return; }
      await cvc.send(`<@${member.id}> 📷 Please enable your camera — you have **${warningMinutes} minute(s)** before you'll be moved out of ${cvc}.${announcementLine(guildId)}`);
      const warnTimeoutId = setTimeout(async () => {
        try {
          if (!isCameraPolicyEnabled(guildId)) { warnedUsers.delete(key); return; }
          const c2 = member.voice?.channel;
          const in2 = c2 && getEffectiveMonitoredChannelIds(guildId, member.guild).has(c2.id);
          if (in2 && !member.voice.selfVideo) {
            await member.voice.disconnect('Camera not enabled within warning period');
            await c2.send(`<@${member.id}> ❌ You were moved out for not enabling your camera. Feel free to rejoin anytime with it on!`);
          }
        } catch (err) { console.error('[camera] removal error:', err.message); }
        finally { warnedUsers.delete(key); }
      }, warnMs);
      warnedUsers.set(key, { stage: 'warned', warnTimeoutId, channel: cvc });
    } catch (err) { console.error('[camera] reminder error:', err.message); warnedUsers.delete(key); }
  }, graceMs);
  warnedUsers.set(key, { stage: 'grace', graceTimeoutId, channel });
}

async function clearWarning(guildId, userId, { confirm = true } = {}) {
  const key  = warnKey(guildId, userId);
  const info = warnedUsers.get(key);
  if (!info) return;
  if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
  if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
  warnedUsers.delete(key);
  if (confirm && info.stage === 'warned' && info.channel) {
    try { await info.channel.send(`<@${userId}> ✅ Thanks for turning your camera on!`); }
    catch (err) { console.error('[camera] confirm send error:', err.message); }
  }
}

// ===========================================================================
//  CHANNEL INDEX CONFIG
// ===========================================================================
const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildMedia]: 'media',
};

let channelIndexConfig = {};

async function loadChannelIndexConfig() {
  const val = await dbGet('channel_index_config');
  channelIndexConfig = val || {};
}
async function saveChannelIndexConfig(c) {
  channelIndexConfig = c;
  return dbSet('channel_index_config', c);
}

function ensureChannelIndexGuildConfig(guildId) {
  if (!channelIndexConfig[guildId]) {
    channelIndexConfig[guildId] = {
      excludedCategoryIds: [],
      excludedChannelIds: [],
      excludedNameKeywords: guildId === GUILD_ID ? ['ticket'] : [],
    };
    saveChannelIndexConfig(channelIndexConfig);
  }
  return channelIndexConfig[guildId];
}

function getChannelData(guild, categoryFilter = null) {
  return guild.channels.cache
    .filter(ch => ch.type !== ChannelType.GuildCategory)
    .filter(ch => !categoryFilter || ch.parent?.name?.toLowerCase() === categoryFilter.toLowerCase())
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(ch => ({
      name: ch.name, id: ch.id,
      type: CHANNEL_TYPE_NAMES[ch.type] || 'unknown',
      category: ch.parent ? ch.parent.name : null,
      categoryId: ch.parentId || null,
      link: `https://discord.com/channels/${guild.id}/${ch.id}`,
      topic: ch.topic || null,
    }));
}

// ===========================================================================
//  DESCRIPTIONS
// ===========================================================================
let descriptionsCache = {};

async function loadAllDescriptions() {
  const val = await dbGet('descriptions');
  descriptionsCache = val || {};
  return descriptionsCache;
}
async function saveAllDescriptions(all) {
  descriptionsCache = all;
  return dbSet('descriptions', all);
}
function loadDescriptions(guildId) { return descriptionsCache[guildId] || {}; }
async function ensureDescriptionsLoaded(guild) {
  if (!descriptionsCache[guild.id]) {
    const data = getChannelData(guild);
    const template = {};
    for (const ch of data) template[ch.id] = { name: ch.name, description: '' };
    descriptionsCache[guild.id] = template;
    await saveAllDescriptions(descriptionsCache);
  }
}

// ===========================================================================
//  VC SHUFFLE / HIGH-SPEED CONNECTION
// ===========================================================================
let vcShuffleConfig = {};

async function loadVcShuffleConfig() {
  const val = await dbGet('speed_match_config');
  vcShuffleConfig = val || {};
}
async function saveVcShuffleConfig(d) {
  vcShuffleConfig = d;
  return dbSet('speed_match_config', d);
}

function ensureVcShuffleGuildConfig(guildId) {
  if (!vcShuffleConfig[guildId]) {
    vcShuffleConfig[guildId] = {
      enabled: false, lobbyChannelIds: [], categoryId: null,
      minGroupSize: 1, maxGroupSize: 1,
      minIntervalMinutes: 3, maxIntervalMinutes: 3,
      announcementChannelId: null, createdChannelIds: [],
      participantRoleId: null, staffRoleIds: [], botRoleId: null,
      warningSeconds: 30,
      eventCategoryId: null, matchupsChannelId: null,
      staffPanelChannelId: null, infoChannelId: null, staffPanelMessageId: null,
      cloudRoomIds: [],
      connectionMode: 'standard',
      pairingPools: [],
      holdingChannelId: null,
    };
    saveVcShuffleConfig(vcShuffleConfig);
  }
  const c = vcShuffleConfig[guildId];
  if (!c.announcementChannelId) c.announcementChannelId = null;
  if (!c.createdChannelIds) c.createdChannelIds = [];
  if (c.participantRoleId === undefined) c.participantRoleId = null;
  if (!c.staffRoleIds) c.staffRoleIds = [];
  if (c.botRoleId === undefined) c.botRoleId = null;
  if (c.warningSeconds === undefined) c.warningSeconds = 30;
  if (c.eventCategoryId === undefined) c.eventCategoryId = null;
  if (c.matchupsChannelId === undefined) c.matchupsChannelId = null;
  if (c.staffPanelChannelId === undefined) c.staffPanelChannelId = null;
  if (c.infoChannelId === undefined) c.infoChannelId = null;
  if (c.staffPanelMessageId === undefined) c.staffPanelMessageId = null;
  if (!c.cloudRoomIds) c.cloudRoomIds = [];
  c.cloudRoomIds = [...new Set(c.cloudRoomIds)];
  if (!c.connectionMode) c.connectionMode = 'standard';
  if (!c.pairingPools) c.pairingPools = [];
  if (c.holdingChannelId === undefined) c.holdingChannelId = null;
  return c;
}

// In-memory session state per guild
const shuffleState = new Map();
const roomButtonMessages = new Map();

const BELL_MESSAGES = [
  '🔔 **Time\'s up!** The bell rings — moving everyone to fresh connections...',
  '🔔 **Ding ding!** Round over — rotating to new conversations...',
  '🔔 **Bell\'s ringing!** Hope it was good. Shuffling you into something new...',
  '🔔 **Connection complete.** Time to meet someone new — rotating now...',
  '🔔 **Round over!** Wrapping up and moving on — see you on the flip side...',
];

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function speedMatchPair(members, groupSize, pairHistory, skipHistory) {
  const combined = new Set([...pairHistory, ...skipHistory]);
  if (groupSize >= 2) return splitIntoGroups(members, groupSize, groupSize);
  const pool = shuffleArray(members);
  const paired = new Set(); const groups = [];
  for (let i = 0; i < pool.length; i++) {
    if (paired.has(pool[i].id)) continue;
    let partner = null;
    for (let j = i + 1; j < pool.length; j++) {
      if (paired.has(pool[j].id)) continue;
      if (!combined.has(pairKey(pool[i].id, pool[j].id))) { partner = pool[j]; break; }
    }
    if (!partner) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id) && !skipHistory.has(pairKey(pool[i].id, pool[j].id))) { partner = pool[j]; break; }
      }
    }
    if (!partner) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id)) { partner = pool[j]; break; }
      }
    }
    if (partner) {
      paired.add(pool[i].id); paired.add(partner.id);
      groups.push([pool[i], partner]);
    }
  }
  const unpaired = pool.filter(m => !paired.has(m.id));
  if (unpaired.length && groups.length > 0) groups[groups.length - 1].push(...unpaired);
  else if (unpaired.length) groups.push(unpaired);
  return groups;
}

function roleBasedPair(members, pairingPools, pairHistory, skipHistory) {
  const buckets = {}; const memberPool = {};
  for (const pool of pairingPools) {
    buckets[pool.poolName] = [];
    for (const m of members) {
      if (pool.roleIds.some(rid => m.roles.cache.has(rid))) {
        buckets[pool.poolName].push(m); memberPool[m.id] = pool.poolName;
      }
    }
  }
  const unassigned = members.filter(m => !memberPool[m.id]);
  const groups = []; const paired = new Set();
  for (const pool of pairingPools) {
    if (pool.pairWith === 'self') {
      const poolMembers = shuffleArray(buckets[pool.poolName] || []).filter(m => !paired.has(m.id));
      for (let i = 0; i < poolMembers.length - 1; i += 2) {
        paired.add(poolMembers[i].id); paired.add(poolMembers[i+1].id);
        groups.push([poolMembers[i], poolMembers[i+1]]);
      }
      const leftover = poolMembers.filter(m => !paired.has(m.id));
      if (leftover.length && groups.length > 0) groups[groups.length - 1].push(...leftover);
    } else if (pool.pairWith === 'other' && pool.otherPoolName) {
      const aPool = shuffleArray((buckets[pool.poolName] || []).filter(m => !paired.has(m.id)));
      const bPool = shuffleArray((buckets[pool.otherPoolName] || []).filter(m => !paired.has(m.id)));
      const minLen = Math.min(aPool.length, bPool.length);
      for (let i = 0; i < minLen; i++) {
        paired.add(aPool[i].id); paired.add(bPool[i].id); groups.push([aPool[i], bPool[i]]);
      }
    }
  }
  const remaining = [...unassigned, ...members.filter(m => !paired.has(m.id))];
  if (remaining.length >= 2) groups.push(...speedMatchPair(remaining, 1, pairHistory, skipHistory));
  else if (remaining.length === 1 && groups.length > 0) groups[groups.length - 1].push(remaining[0]);
  return groups;
}

function splitIntoGroups(members, minSize, maxSize) {
  const shuffled = shuffleArray(members); const groups = []; let i = 0;
  while (i < shuffled.length) {
    const remaining = shuffled.length - i;
    if (remaining <= maxSize) { groups.push(shuffled.slice(i)); break; }
    const size = Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize;
    groups.push(shuffled.slice(i, i + size)); i += size;
  }
  return groups;
}

function recordPairs(group, pairHistory) {
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++)
      pairHistory.add(pairKey(group[i].id, group[j].id));
}

async function cleanupShuffleChannels(guild, cfg) {
  const toDelete = [...cfg.createdChannelIds];
  cfg.createdChannelIds = []; await saveVcShuffleConfig(vcShuffleConfig);
  for (const id of toDelete) {
    try { const ch = guild.channels.cache.get(id); if (ch) await ch.delete('Speed Match session ended'); }
    catch (err) { console.error(`[speed-match] delete temp channel ${id}:`, err.message); }
  }
}

async function moveEveryoneToLobby(guild, cfg) {
  if (!cfg.lobbyChannelIds.length) return;
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  if (!lobby) return;
  for (const channelId of cfg.createdChannelIds) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      try { await m.voice.setChannel(lobby, 'Speed Match: returning to lobby'); }
      catch (err) { console.error(`[speed-match] move to lobby:`, err.message); }
    }
  }
}

async function postRoomActionButtons(guild, guildId, roomCh, groupMembers) {
  try {
    const prevMsgId = roomButtonMessages.get(roomCh.id);
    if (prevMsgId) {
      try { const pm = await roomCh.messages.fetch(prevMsgId).catch(() => null); if (pm) await pm.delete(); } catch {}
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hsc:matchagain:${roomCh.id}`).setLabel('🔁 Match Again').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hsc:skip:${roomCh.id}`).setLabel('⏭️ Skip').setStyle(ButtonStyle.Danger),
    );
    const msg = await roomCh.send({
      content: `👋 **You've been matched!**\n🔁 **Match Again** — both must vote to be re-paired next round\n⏭️ **Skip** — moves you to holding silently; your match stays until the bell`,
      components: [row],
    });
    roomButtonMessages.set(roomCh.id, msg.id);
  } catch (err) { console.error(`[speed-match] postRoomActionButtons:`, err.message); }
}

async function runShuffleRound(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.enabled || !cfg.lobbyChannelIds.length) return;
  const state = shuffleState.get(guildId);
  if (!state) return;
  if (state.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
  state.roundNumber = (state.roundNumber || 0) + 1;
  const round = state.roundNumber;
  if (!state.pairHistory)     state.pairHistory    = new Set();
  if (!state.skipHistory)     state.skipHistory    = new Set();
  if (!state.matchAgainVotes) state.matchAgainVotes = new Map();

  const confirmedRePairs = new Set(); const matchPairs = [];
  for (const [voterId, partnerId] of state.matchAgainVotes.entries()) {
    if (state.matchAgainVotes.get(partnerId) === voterId && !confirmedRePairs.has(voterId)) {
      confirmedRePairs.add(voterId); confirmedRePairs.add(partnerId);
      matchPairs.push([voterId, partnerId]);
    }
  }
  state.matchAgainVotes = new Map();
  console.log(`[speed-match] Guild ${guildId}: round #${round}, rePairs=${matchPairs.length}`);

  const cloudRoomIds = cfg.cloudRoomIds || [];
  const allSourceIds = [...cfg.lobbyChannelIds, ...cloudRoomIds];
  const seen = new Set(); const pool = [];
  for (const chId of allSourceIds) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      if (m.user.bot || seen.has(m.id)) continue;
      seen.add(m.id); pool.push(m);
    }
  }

  const matchupTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  const matchupCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;

  if (pool.length < 2) {
    console.log(`[speed-match] Guild ${guildId}: only ${pool.length} member(s) — skipping round`);
    if (matchupCh) {
      const msg = await matchupCh.send(`⚠️ Not enough people in the lobby for Round #${round} — waiting for more to join!`).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => {}), 15000);
    }
    scheduleNextShuffle(guild, guildId); return;
  }

  if (cfg.participantRoleId) {
    for (const m of pool) {
      if (!m.roles.cache.has(cfg.participantRoleId))
        await m.roles.add(cfg.participantRoleId, '💨 HSC: joined session').catch(() => {});
    }
  }

  const rePairedIds = new Set(matchPairs.flat());
  const remainingPool = pool.filter(m => !rePairedIds.has(m.id));

  let groups;
  if (cfg.connectionMode === 'role-based' && cfg.pairingPools.length > 0) {
    groups = roleBasedPair(remainingPool, cfg.pairingPools, state.pairHistory, state.skipHistory);
  } else {
    groups = speedMatchPair(remainingPool, cfg.minGroupSize ?? 1, state.pairHistory, state.skipHistory);
  }
  for (const [aid, bid] of matchPairs) {
    const ma = pool.find(m => m.id === aid); const mb = pool.find(m => m.id === bid);
    if (ma && mb) groups.unshift([ma, mb]);
  }
  for (const group of groups) recordPairs(group, state.pairHistory);

  if (round === 1 && matchupCh) {
    for (const num of ['5️⃣', '4️⃣', '3️⃣', '2️⃣', '1️⃣']) {
      const m = await matchupCh.send(num).catch(() => null);
      await new Promise(r => setTimeout(r, 1000));
      if (m) m.delete().catch(() => {});
    }
    const go = await matchupCh.send('💨 **GO!**').catch(() => null);
    if (go) setTimeout(() => go.delete().catch(() => {}), 3000);
  }

  if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
  const activeRoomIds = [];
  for (let i = 0; i < groups.length; i++) {
    const existingId = cfg.cloudRoomIds[i];
    let roomCh = existingId ? guild.channels.cache.get(existingId) : null;
    if (!roomCh) {
      try {
        roomCh = await guild.channels.create({ name: `speed-match-${i + 1}`, type: ChannelType.GuildVoice, parent: cfg.categoryId || null, reason: `💨 HSC round #${round} room` });
        cfg.cloudRoomIds[i] = roomCh.id;
      } catch (err) { console.error(`[speed-match] create room ${i + 1}:`, err.message); continue; }
    }
    activeRoomIds.push(roomCh.id);
    for (const m of groups[i])
      await roomCh.permissionOverwrites.edit(m, { ViewChannel: true, Connect: true, Speak: true }).catch(() => {});
    for (const m of groups[i])
      await m.voice.setChannel(roomCh, `💨 HSC round #${round}`).catch(err => console.error(`[speed-match] move ${m.id}:`, err.message));
    await postRoomActionButtons(guild, guildId, roomCh, groups[i]);
  }

  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  for (let i = groups.length; i < cfg.cloudRoomIds.length; i++) {
    const roomCh = guild.channels.cache.get(cfg.cloudRoomIds[i]);
    if (!roomCh) continue;
    for (const m of roomCh.members.values()) {
      if (m.user.bot) continue;
      if (lobby) await m.voice.setChannel(lobby, '💨 Moved to lobby — room unused').catch(() => {});
    }
  }
  cfg.createdChannelIds = activeRoomIds;
  cfg.cloudRoomIds = activeRoomIds;
  await saveVcShuffleConfig(vcShuffleConfig);

  if (matchupCh) {
    try {
      const groupLines = groups.map((g, i) => {
        const names = g.map(m => `<@${m.id}>`).join(' ↔ ');
        const note = g.length > 2 ? ' *(trio)*' : (rePairedIds.has(g[0]?.id) ? ' *(rematched!)*' : '');
        return `speed-match-${i + 1} — ${names}${note}`;
      }).join('\n');
      const allMet = pool.length > 1 && state.pairHistory.size >= (pool.length * (pool.length - 1)) / 2;
      const embed = new EmbedBuilder().setColor(0x8a2be2)
        .setTitle(`💨 Round #${round} Matchups`)
        .setDescription(`**${pool.length}** people · **${groups.length}** room${groups.length !== 1 ? 's' : ''}\n\n${groupLines}${allMet ? '\n\n🎉 Everyone\'s met everyone — resetting pair history!' : ''}`)
        .setFooter({ text: `~${cfg.minIntervalMinutes ?? 3} min per round · Use 🔁/⏭️ buttons in your room` })
        .setTimestamp();
      await matchupCh.send({ embeds: [embed] });
      if (allMet) { state.pairHistory = new Set(); state.skipHistory = new Set(); }
    } catch (err) { console.error(`[speed-match] post matchups:`, err.message); }
  }
  await refreshStaffPanel(guild, guildId);

  const roundMs  = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const warnSecs = cfg.warningSeconds ?? 30;
  const warnMs   = Math.max(0, roundMs - warnSecs * 1000);
  const warningTimeoutId = warnMs > 0 ? setTimeout(async () => {
    const warnCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;
    if (warnCh) {
      const wm = await warnCh.send(`⏰ **${warnSecs} seconds left!** Wrap it up — the bell rings soon! 🔔`).catch(() => null);
      if (wm) setTimeout(() => wm.delete().catch(() => {}), Math.max(0, (warnSecs - 3) * 1000));
    }
  }, warnMs) : null;
  const cur = shuffleState.get(guildId) || state;
  cur.warningTimeoutId = warningTimeoutId;
  shuffleState.set(guildId, cur);
  console.log(`[speed-match] Guild ${guildId}: round #${round} — ${pool.length} people in ${groups.length} rooms`);
}

function buildStaffPanelContent(guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  const running = cfg.enabled; const round = state?.roundNumber ?? 0;
  const pairs = state?.pairHistory?.size ?? 0;
  const nextAt = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : '—';
  const mode = cfg.connectionMode === 'role-based' ? 'Role-Based' : ((cfg.minGroupSize ?? 1) === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
  const embed = new EmbedBuilder().setColor(running ? 0x8a2be2 : 0x555555)
    .setTitle('💨 Speed Match — Master Panel')
    .setDescription('Live event controls. Use buttons below to manage the session.')
    .addFields(
      { name: 'Status', value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
      { name: 'Round', value: String(round), inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Round length', value: `${cfg.minIntervalMinutes ?? 3}m`, inline: true },
      { name: 'Next bell', value: running ? nextAt : '—', inline: true },
      { name: 'Unique pairs', value: String(pairs), inline: true },
    ).setFooter({ text: 'Auto-updates each round' }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('speedmatch:start').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(running),
    new ButtonBuilder().setCustomId('speedmatch:bell').setLabel('🔔 Next Round').setStyle(ButtonStyle.Primary).setDisabled(!running),
    new ButtonBuilder().setCustomId('speedmatch:stop').setLabel('⏹️ End Session').setStyle(ButtonStyle.Danger).setDisabled(!running),
  );
  return { embeds: [embed], components: [row] };
}

async function refreshStaffPanel(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.staffPanelChannelId) return;
  try {
    const ch = guild.channels.cache.get(cfg.staffPanelChannelId);
    if (!ch) return;
    const content = buildStaffPanelContent(guildId);
    if (cfg.staffPanelMessageId) {
      try { const msg = await ch.messages.fetch(cfg.staffPanelMessageId); await msg.edit(content); return; } catch {}
    }
    const msg = await ch.send(content);
    cfg.staffPanelMessageId = msg.id; await saveVcShuffleConfig(vcShuffleConfig);
  } catch (err) { console.error(`[speed-match] refreshStaffPanel:`, err.message); }
}

async function postBellMessage(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const target = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (!target) return;
  try {
    const ch = guild.channels.cache.get(target); if (!ch) return;
    const state = shuffleState.get(guildId);
    const msg = await ch.send(BELL_MESSAGES[(state?.roundNumber ?? 0) % BELL_MESSAGES.length]);
    setTimeout(() => msg.delete().catch(() => {}), 10000);
  } catch (err) { console.error(`[speed-match] postBellMessage:`, err.message); }
}

function randomIntervalMs(cfg) {
  const min = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const max = (cfg.maxIntervalMinutes ?? cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  return Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
}

function scheduleNextShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); if (!cfg.enabled) return;
  const delay = randomIntervalMs(cfg); const nextAt = Date.now() + delay;
  const state = shuffleState.get(guildId) || {};
  if (state.timeoutId) clearTimeout(state.timeoutId);
  if (state.warningTimeoutId) clearTimeout(state.warningTimeoutId);
  const timeoutId = setTimeout(async () => {
    try { await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); }
    catch (err) { console.error(`[speed-match] round error ${guildId}:`, err.message); }
    const freshCfg = ensureVcShuffleGuildConfig(guildId);
    if (freshCfg.enabled) scheduleNextShuffle(guild, guildId);
    else shuffleState.delete(guildId);
  }, delay);
  shuffleState.set(guildId, { ...state, timeoutId, warningTimeoutId: null, nextShuffleAt: nextAt });
  console.log(`[speed-match] Guild ${guildId}: next round in ${Math.round(delay / 1000)}s`);
}

async function startVcShuffle(guild, guildId, runImmediately = false) {
  const cfg = ensureVcShuffleGuildConfig(guildId); cfg.enabled = true; await saveVcShuffleConfig(vcShuffleConfig);
  const existing = shuffleState.get(guildId);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  if (existing?.warningTimeoutId) clearTimeout(existing.warningTimeoutId);
  shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set(), skipHistory: new Set(), matchAgainVotes: new Map() });
  if (runImmediately) await runShuffleRound(guild, guildId);
  scheduleNextShuffle(guild, guildId);
}

async function stopVcShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  cfg.enabled = false; await saveVcShuffleConfig(vcShuffleConfig);
  if (state?.timeoutId) clearTimeout(state.timeoutId);
  if (state?.warningTimeoutId) clearTimeout(state.warningTimeoutId);
  await moveEveryoneToLobby(guild, cfg); await cleanupShuffleChannels(guild, cfg);
  if (cfg.participantRoleId) {
    for (const chId of cfg.lobbyChannelIds) {
      const ch = guild.channels.cache.get(chId); if (!ch) continue;
      for (const m of ch.members.values()) {
        try { if (m.roles.cache.has(cfg.participantRoleId)) await m.roles.remove(cfg.participantRoleId, '💨 HSC: session ended'); }
        catch (err) { console.error(`[speed-match] remove participant role:`, err.message); }
      }
    }
  }
  const summaryTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (summaryTarget && state?.pairHistory) {
    try {
      const textCh = guild.channels.cache.get(summaryTarget);
      if (textCh) {
        const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('💨 Speed Match — Session Over')
          .setDescription(`That's a wrap!\n\n**Rounds completed:** ${state.roundNumber ?? 0}\n**Unique connections made:** ${state.pairHistory.size}\n\nEveryone has been returned to the lobby. Hope you made some good connections.`)
          .setTimestamp();
        await textCh.send({ embeds: [embed] });
      }
    } catch (err) { console.error(`[speed-match] session summary:`, err.message); }
  }
  shuffleState.delete(guildId); await refreshStaffPanel(guild, guildId);
}

// Re-arm on restart
client.once('clientReady', () => {
  for (const [guildId, cfg] of Object.entries(vcShuffleConfig)) {
    if (!cfg.enabled) continue;
    const guild = client.guilds.cache.get(guildId); if (!guild) continue;
    console.log(`[speed-match] Resuming for guild ${guildId}`);
    shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set(), skipHistory: new Set(), matchAgainVotes: new Map() });
    scheduleNextShuffle(guild, guildId);
  }
});

// ===========================================================================
//  VOICE STATE UPDATE — camera + participant role
// ===========================================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id; const userId = newState.id;
  const nowIn = !!newState.channelId;

  if (nowIn && newState.member && !newState.member.user.bot) {
    const sc = vcShuffleConfig[guildId];
    if (sc?.enabled && sc.participantRoleId && sc.lobbyChannelIds?.includes(newState.channelId)) {
      try {
        if (!newState.member.roles.cache.has(sc.participantRoleId))
          await newState.member.roles.add(sc.participantRoleId, '💨 HSC: joined lobby');
      } catch (err) { console.error(`[speed-match] participant role assign fail:`, err.message); }
    }
  }

  if (!isCameraPolicyEnabled(guildId)) return;
  const channelId = newState.channelId;
  if (!channelId || !getEffectiveMonitoredChannelIds(guildId, newState.guild).has(channelId)) {
    if (!newState.channelId) await clearWarning(guildId, userId, { confirm: false });
    return;
  }
  const member = newState.member; const channel = newState.channel;
  const key = warnKey(guildId, userId);
  if (warnedUsers.has(key)) warnedUsers.get(key).channel = channel;
  const isExempt = member.roles.cache.some(r => getExemptRoles(guildId).includes(r.id));
  if (isExempt) { await clearWarning(guildId, userId, { confirm: false }); return; }
  if (!newState.selfVideo) await handleCameraOff(member, channel);
  else await clearWarning(guildId, userId, { confirm: true });
});

// ===========================================================================
//  SETUP MENU (/setup command)
// ===========================================================================
function buildMainMenuMessage() {
  const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT — Setup')
    .setDescription('Select a feature to configure. Each module walks you through setup one step at a time.\n\n> Return here anytime with `/setup`.');
  const moduleSelect = new StringSelectMenuBuilder().setCustomId('setup:main:select').setPlaceholder('Choose a feature to set up...')
    .addOptions(
      { label: 'Camera Policy',   description: 'Enforce cameras-on in voice channels',            value: 'camera',      emoji: '📷' },
      { label: 'Speed Match',     description: 'Configure speed matching events',                  value: 'speedmatch',  emoji: '💨' },
      { label: 'Temp Roles',      description: 'VC presence roles and timed button roles',         value: 'temproles',   emoji: '🎭' },
      { label: 'Sticky Notes',    description: 'Messages that re-pin at the bottom of a channel', value: 'sticky',      emoji: '📌' },
      { label: 'Auto Responder',  description: 'Auto-reply to trigger words or phrases',           value: 'autorespond', emoji: '🤖' },
      { label: 'Channel Index',   description: 'Exclusions & descriptions for /channel-index',    value: 'chindex',     emoji: '#️⃣' },
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(moduleSelect)] };
}

function buildCameraMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId); const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('📷 Camera Policy — Setup')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
      `**Timing:** ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning\n` +
      `**Announcement Channel:** ${cfg.announcementChannelId ? `<#${cfg.announcementChannelId}>` : 'Not set'}\n` +
      `**Announcement URL:** ${cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not set'}\n` +
      `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Monitored Categories:** ${catCount ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Exempt Roles:** ${cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : 'Not set'}\n\n` +
      `> 💡 You can select channels, categories, or both for monitoring.`
    );
  const topRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:toggle').setLabel(cfg.enabled ? '🔴 Disable' : '🟢 Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:camera:timing').setLabel('⏱ Set Timing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:announcement').setLabel('📢 Announcement').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:categories-menu').setLabel('🗂 Categories').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  const channelSelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:channels:select').setPlaceholder('Select monitored voice channels...').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(0).setMaxValues(25);
  if (cfg.monitoredChannels.length) channelSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));
  const announceSelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:announcechannel:select').setPlaceholder('Select announcement channel (optional)...').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
  if (cfg.announcementChannelId) announceSelect.setDefaultChannels(cfg.announcementChannelId);
  const roleSelect = new RoleSelectMenuBuilder().setCustomId('setup:camera:exempt:select').setPlaceholder('Select exempt role(s)...').setMinValues(0).setMaxValues(25);
  if (cfg.exemptRoles.length) roleSelect.setDefaultRoles(...cfg.exemptRoles.slice(0, 25));
  return { embeds: [embed], components: [topRow, new ActionRowBuilder().addComponents(channelSelect), new ActionRowBuilder().addComponents(announceSelect), new ActionRowBuilder().addComponents(roleSelect)] };
}

function buildCameraCategoriesMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId); const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('📷 Camera Policy — Monitored Categories')
    .setDescription(`Select categories below. Every voice channel inside will be monitored.\n\n**Currently monitored:** ${catCount ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'None'}`);
  const backRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:camera:menu').setLabel('⬅ Back to Camera Policy').setStyle(ButtonStyle.Secondary));
  const categorySelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:categories:select').setPlaceholder('Select monitored categories...').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(25);
  if (catCount) categorySelect.setDefaultChannels(...cfg.monitoredCategoryIds.slice(0, 25));
  return { embeds: [embed], components: [backRow, new ActionRowBuilder().addComponents(categorySelect)] };
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup')
      return interaction.reply({ ...buildMainMenuMessage(), flags: MessageFlags.Ephemeral });
    if (!interaction.customId?.startsWith('setup:')) return;
    if (!interaction.isButton() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    const guildId = interaction.guildId; const id = interaction.customId;

    if (id === 'setup:main') return interaction.update(buildMainMenuMessage());
    if (id === 'setup:main:select') {
      const v = interaction.values[0];
      if (v === 'camera')     return interaction.update(buildCameraMenuMessage(guildId));
      if (v === 'speedmatch') return interaction.update(buildSpeedMatchSetupMessage(guildId));
      if (v === 'temproles')  return interaction.update(buildTempRolesSetupMessage(guildId));
      if (v === 'sticky' || v === 'autorespond') return interaction.update(buildStickyARSetupMessage(guildId, v));
      return;
    }

    if (id === 'setup:camera:menu')            return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:camera:categories-menu') return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    if (id === 'setup:camera:toggle') {
      const cfg = ensureGuildConfig(guildId); cfg.enabled = !cfg.enabled;
      const saved = await saveCameraConfig(cameraConfig);
      if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
      await interaction.update(buildCameraMenuMessage(guildId));
      if (!saved) await interaction.followUp({ content: '⚠️ Save failed.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === 'setup:camera:channels:select') { ensureGuildConfig(guildId).monitoredChannels = interaction.values; await saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
    if (id === 'setup:camera:announcechannel:select') { ensureGuildConfig(guildId).announcementChannelId = interaction.values[0] || null; await saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
    if (id === 'setup:camera:categories:select') { ensureGuildConfig(guildId).monitoredCategoryIds = interaction.values; await saveCameraConfig(cameraConfig); return interaction.update(buildCameraCategoriesMenuMessage(guildId)); }
    if (id === 'setup:camera:exempt:select') { ensureGuildConfig(guildId).exemptRoles = interaction.values; await saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
    if (id === 'setup:camera:timing') {
      const cfg = ensureGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:camera:timing:modal').setTitle('Camera Policy Timing');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('grace').setLabel('Grace period (minutes, silent)').setStyle(TextInputStyle.Short).setValue(String(cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES)).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('warning').setLabel('Warning period (minutes)').setStyle(TextInputStyle.Short).setValue(String(cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES)).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (id === 'setup:camera:announcement') {
      const cfg = ensureGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:camera:announcement:modal').setTitle('Camera Policy Announcement URL');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('Announcement message link (optional)').setStyle(TextInputStyle.Short).setValue(cfg.announcementUrl || '').setRequired(false).setPlaceholder('https://discord.com/channels/...')));
      return interaction.showModal(modal);
    }
    if (id === 'setup:camera:timing:modal') {
      const grace = parseInt(interaction.fields.getTextInputValue('grace'), 10);
      const warning = parseInt(interaction.fields.getTextInputValue('warning'), 10);
      if (!Number.isInteger(grace) || !Number.isInteger(warning) || grace < 0 || warning < 1) return interaction.reply({ content: '❌ Grace must be 0+ and warning 1+.', flags: MessageFlags.Ephemeral });
      const cfg = ensureGuildConfig(guildId); cfg.graceMinutes = grace; cfg.warningMinutes = warning;
      await saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:announcement:modal') {
      ensureGuildConfig(guildId).announcementUrl = interaction.fields.getTextInputValue('url')?.trim() || null;
      await saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }

    if (id === 'setup:sm:menu') return interaction.update(buildSpeedMatchSetupMessage(guildId));
    if (id === 'setup:sm:lobby:select') { ensureVcShuffleGuildConfig(guildId).lobbyChannelIds = interaction.values; await saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:matchups:select') { ensureVcShuffleGuildConfig(guildId).matchupsChannelId = interaction.values[0] || null; await saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:staffpanel:select') { const c = ensureVcShuffleGuildConfig(guildId); c.staffPanelChannelId = interaction.values[0] || null; c.staffPanelMessageId = null; await saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:setinterval') {
      const cfg = ensureVcShuffleGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:sm:interval:modal').setTitle('Speed Match — Round Interval');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min').setLabel('Min minutes per round').setStyle(TextInputStyle.Short).setValue(String(cfg.minIntervalMinutes ?? 3)).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('max').setLabel('Max minutes per round').setStyle(TextInputStyle.Short).setValue(String(cfg.maxIntervalMinutes ?? 3)).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (id === 'setup:sm:interval:modal') {
      const min = parseInt(interaction.fields.getTextInputValue('min'), 10); const max = parseInt(interaction.fields.getTextInputValue('max'), 10);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return interaction.reply({ content: '❌ Min must be 1+ and max ≥ min.', flags: MessageFlags.Ephemeral });
      const cfg = ensureVcShuffleGuildConfig(guildId); cfg.minIntervalMinutes = min; cfg.maxIntervalMinutes = max; await saveVcShuffleConfig(vcShuffleConfig);
      return interaction.update(buildSpeedMatchSetupMessage(guildId));
    }
    if (id === 'setup:sm:start') {
      const cfg = ensureVcShuffleGuildConfig(guildId);
      if (!cfg.lobbyChannelIds?.length) return interaction.reply({ content: '❌ Set a lobby channel first.', flags: MessageFlags.Ephemeral });
      await interaction.deferUpdate(); await startVcShuffle(interaction.guild, guildId, true);
      return interaction.editReply(buildSpeedMatchSetupMessage(guildId));
    }
    if (id === 'setup:sm:bell') {
      const state = shuffleState.get(guildId);
      if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
      await interaction.deferUpdate(); await postBellMessage(interaction.guild, guildId); await runShuffleRound(interaction.guild, guildId); scheduleNextShuffle(interaction.guild, guildId); await refreshStaffPanel(interaction.guild, guildId);
      return interaction.editReply(buildSpeedMatchSetupMessage(guildId));
    }
    if (id === 'setup:sm:stop') { await interaction.deferUpdate(); await stopVcShuffle(interaction.guild, guildId); return interaction.editReply(buildSpeedMatchSetupMessage(guildId)); }

    if (id === 'setup:tr:menu') return interaction.update(buildTempRolesSetupMessage(guildId));
    if (id === 'setup:tr:vcconfig') {
      const modal = new ModalBuilder().setCustomId('setup:tr:vcconfig:modal').setTitle('VC Role Config');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roleId').setLabel('Role ID (right-click role → Copy ID)').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announceChannelId').setLabel('Announcement channel ID (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vcTextChannelId').setLabel('VC text channel ID (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announceMsg').setLabel('Custom message (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('{user} joined {channel}! {roles}')),
      );
      return interaction.showModal(modal);
    }
    if (id === 'setup:tr:vcconfig:modal') {
      const tr = await loadTR(); if (!tr[guildId]) tr[guildId] = {};
      const roleId = interaction.fields.getTextInputValue('roleId')?.trim() || null;
      const ac = interaction.fields.getTextInputValue('announceChannelId')?.trim() || null;
      const vt = interaction.fields.getTextInputValue('vcTextChannelId')?.trim() || null;
      const am = interaction.fields.getTextInputValue('announceMsg')?.trim() || null;
      if (roleId) tr[guildId].vcRoleId = roleId;
      if (ac) tr[guildId].announceChannelId = ac;
      if (vt) tr[guildId].vcTextChannelId = vt;
      if (am) tr[guildId].announceMsg = am;
      await saveTR(tr); return interaction.update(buildTempRolesSetupMessage(guildId));
    }
    if (id === 'setup:tr:addtimed') {
      const modal = new ModalBuilder().setCustomId('setup:tr:addtimed:modal').setTitle('Add Timed Role');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roleId').setLabel('Role ID').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (minutes)').setStyle(TextInputStyle.Short).setRequired(true).setValue('30')));
      return interaction.showModal(modal);
    }
    if (id === 'setup:tr:addtimed:modal') {
      const tr = await loadTR(); if (!tr[guildId]) tr[guildId] = {}; if (!tr[guildId].timedRoles) tr[guildId].timedRoles = [];
      const roleId = interaction.fields.getTextInputValue('roleId')?.trim();
      if (!roleId) return interaction.reply({ content: '❌ Role ID required.', flags: MessageFlags.Ephemeral });
      tr[guildId].timedRoles.push({ roleId, durationMinutes: parseInt(interaction.fields.getTextInputValue('duration')) || 30 });
      await saveTR(tr); return interaction.update(buildTempRolesSetupMessage(guildId));
    }
    if (id === 'setup:tr:postbutton') {
      const modal = new ModalBuilder().setCustomId('setup:tr:postbutton:modal').setTitle('Post Timed Role Button');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roleId').setLabel('Role ID').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channelId').setLabel('Channel ID to post button in').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setRequired(false).setValue('Get Role')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message above button (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
      );
      return interaction.showModal(modal);
    }
    if (id === 'setup:tr:postbutton:modal') {
      const roleId = interaction.fields.getTextInputValue('roleId')?.trim();
      const channelId = interaction.fields.getTextInputValue('channelId')?.trim();
      const label = interaction.fields.getTextInputValue('label')?.trim() || 'Get Role';
      const message = interaction.fields.getTextInputValue('message')?.trim() || null;
      const ch = interaction.guild.channels.cache.get(channelId);
      if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
      await ch.send({ content: message || undefined, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`temprole:${roleId}`).setLabel(label).setStyle(ButtonStyle.Primary))] });
      return interaction.reply({ content: `✅ Button posted in <#${channelId}>!`, flags: MessageFlags.Ephemeral });
    }

    if (id === 'setup:sticky:add') {
      const modal = new ModalBuilder().setCustomId('setup:sticky:add:modal').setTitle('Add Sticky Note');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channelId').setLabel('Channel ID').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Sticky message content').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (id === 'setup:sticky:add:modal') {
      const channelId = interaction.fields.getTextInputValue('channelId')?.trim();
      const content = interaction.fields.getTextInputValue('content')?.trim();
      if (!channelId || !content) return interaction.reply({ content: '❌ Channel ID and message required.', flags: MessageFlags.Ephemeral });
      const sticky = await loadSticky(); if (!sticky[guildId]) sticky[guildId] = {};
      sticky[guildId][channelId] = { content }; await saveSticky(sticky);
      return interaction.reply({ content: `✅ Sticky set for <#${channelId}>!`, flags: MessageFlags.Ephemeral });
    }

    if (id === 'setup:ar:add') {
      const modal = new ModalBuilder().setCustomId('setup:ar:add:modal').setTitle('Add Auto Responder');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('trigger').setLabel('Trigger phrase').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('matchType').setLabel('Match type: "contains" or "exact"').setStyle(TextInputStyle.Short).setRequired(true).setValue('contains')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('response').setLabel('Response message').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      return interaction.showModal(modal);
    }
    if (id === 'setup:ar:add:modal') {
      const trigger = interaction.fields.getTextInputValue('trigger')?.trim();
      const matchType = interaction.fields.getTextInputValue('matchType')?.trim().toLowerCase() === 'exact' ? 'exact' : 'contains';
      const response = interaction.fields.getTextInputValue('response')?.trim();
      if (!trigger || !response) return interaction.reply({ content: '❌ Trigger and response required.', flags: MessageFlags.Ephemeral });
      const ar = await loadAR(); if (!ar[guildId]) ar[guildId] = [];
      ar[guildId].push({ trigger, matchType, response }); await saveAR(ar);
      return interaction.reply({ content: `✅ Auto responder added! Trigger: \`${trigger}\` (${matchType})`, flags: MessageFlags.Ephemeral });
    }

  } catch (err) {
    console.error('[setup] interaction error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

function buildSpeedMatchSetupMessage(guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId); const running = cfg.enabled;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('💨 Speed Match — Setup')
    .setDescription(`**Status:** ${running ? '🟢 Running' : '🔴 Idle'}\n**Mode:** ${cfg.connectionMode === 'role-based' ? 'Role-Based' : (cfg.minGroupSize === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`)}\n**Interval:** ${cfg.minIntervalMinutes}–${cfg.maxIntervalMinutes} min\n**Lobbies:** ${cfg.lobbyChannelIds?.length ? cfg.lobbyChannelIds.map(id => `<#${id}>`).join(', ') : 'Not set'}\n**Matchups channel:** ${cfg.matchupsChannelId ? `<#${cfg.matchupsChannelId}>` : 'Not set'}\n**Staff panel:** ${cfg.staffPanelChannelId ? `<#${cfg.staffPanelChannelId}>` : 'Not set'}`);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:sm:start').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(running),
    new ButtonBuilder().setCustomId('setup:sm:bell').setLabel('🔔 Next Round').setStyle(ButtonStyle.Primary).setDisabled(!running),
    new ButtonBuilder().setCustomId('setup:sm:stop').setLabel('⏹ End Session').setStyle(ButtonStyle.Danger).setDisabled(!running),
    new ButtonBuilder().setCustomId('setup:sm:setinterval').setLabel('⏱ Set Interval').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  const lobbySelect = new ChannelSelectMenuBuilder().setCustomId('setup:sm:lobby:select').setPlaceholder('Set lobby voice channel(s)...').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(0).setMaxValues(5);
  if (cfg.lobbyChannelIds?.length) lobbySelect.setDefaultChannels(...cfg.lobbyChannelIds.slice(0, 5));
  const matchupsSelect = new ChannelSelectMenuBuilder().setCustomId('setup:sm:matchups:select').setPlaceholder('Set matchups/announcements text channel...').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
  if (cfg.matchupsChannelId) matchupsSelect.setDefaultChannels(cfg.matchupsChannelId);
  const staffSelect = new ChannelSelectMenuBuilder().setCustomId('setup:sm:staffpanel:select').setPlaceholder('Set staff panel channel (staff only)...').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
  if (cfg.staffPanelChannelId) staffSelect.setDefaultChannels(cfg.staffPanelChannelId);
  return { embeds: [embed], components: [row1, new ActionRowBuilder().addComponents(lobbySelect), new ActionRowBuilder().addComponents(matchupsSelect), new ActionRowBuilder().addComponents(staffSelect)] };
}

function buildTempRolesSetupMessage(guildId) {
  const cfg = tempRolesCache[guildId] || {};
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('🎭 Temp Roles — Setup')
    .setDescription(`**VC Role:** ${cfg.vcRoleId ? `<@&${cfg.vcRoleId}>` : 'Not set'}\n**Announce Channel:** ${cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : 'Not set'}\n**VC Text Channel:** ${cfg.vcTextChannelId ? `<#${cfg.vcTextChannelId}>` : 'Not set'}\n**Timed Roles:** ${cfg.timedRoles?.length ? cfg.timedRoles.map(r => `<@&${r.roleId}> (${r.durationMinutes}m)`).join(', ') : 'None'}\n\n> VC Role is applied on join/removed on leave. Timed roles are given via button click and expire automatically.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:tr:vcconfig').setLabel('🔊 VC Role Config').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:tr:addtimed').setLabel('⏱ Add Timed Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:tr:postbutton').setLabel('📤 Post Button').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function buildStickyARSetupMessage(guildId, mode) {
  const isAR = mode === 'autorespond';
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle(isAR ? '🤖 Auto Responder — Setup' : '📌 Sticky Notes — Setup')
    .setDescription((isAR ? 'Auto responders reply when a trigger is detected in any message.' : 'Sticky notes re-post at the bottom of a channel whenever someone sends a message.') + '\n\n> Manage all entries from the Dashboard.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(isAR ? 'setup:ar:add' : 'setup:sticky:add').setLabel(isAR ? '➕ Add Auto Responder' : '➕ Add Sticky Note').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ===========================================================================
//  HSC BUTTON HANDLER
// ===========================================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('speedmatch:')) {
    const guildId = interaction.guildId; const guild = interaction.guild;
    const cfg = ensureVcShuffleGuildConfig(guildId);
    const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      (cfg.staffRoleIds || []).some(id => interaction.member?.roles?.cache?.has(id));
    if (!isStaff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
    const action = interaction.customId.split(':')[1];
    try {
      await interaction.deferUpdate();
      if (action === 'start') {
        if (!cfg.lobbyChannelIds.length) return interaction.followUp({ content: '❌ No lobby channels configured.', flags: MessageFlags.Ephemeral });
        await startVcShuffle(guild, guildId, true);
      } else if (action === 'bell') {
        const state = shuffleState.get(guildId);
        if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
        await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); scheduleNextShuffle(guild, guildId);
      } else if (action === 'stop') { await stopVcShuffle(guild, guildId); }
      await refreshStaffPanel(guild, guildId);
    } catch (err) {
      console.error('[speedmatch] button error:', err);
      try { await interaction.followUp({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral }); } catch {}
    }
    return;
  }

  if (interaction.customId.startsWith('hsc:')) {
    const parts = interaction.customId.split(':'); const action = parts[1]; const roomId = parts[2];
    const guildId = interaction.guildId; const guild = interaction.guild;
    const userId = interaction.user.id; const state = shuffleState.get(guildId);
    if (!state) return interaction.reply({ content: '❌ No active session.', flags: MessageFlags.Ephemeral });
    const roomCh = guild.channels.cache.get(roomId);
    if (!roomCh) return interaction.reply({ content: '❌ Room not found.', flags: MessageFlags.Ephemeral });
    const roomMembers = [...roomCh.members.values()].filter(m => !m.user.bot);
    const partner = roomMembers.find(m => m.id !== userId);
    const cfg = ensureVcShuffleGuildConfig(guildId);

    if (action === 'matchagain') {
      if (!state.matchAgainVotes) state.matchAgainVotes = new Map();
      state.matchAgainVotes.set(userId, partner?.id || null);
      const partnerVoted = partner && state.matchAgainVotes.get(partner.id) === userId;
      if (partnerVoted) return interaction.reply({ content: '🎉 Both of you voted Match Again! You\'ll be paired together next round.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: '🔁 Vote recorded! If your match also votes Match Again, you\'ll be re-paired next round.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'skip') {
      if (partner) {
        if (!state.skipHistory) state.skipHistory = new Set();
        state.skipHistory.add(pairKey(userId, partner.id));
      }
      const holdingCh = cfg.holdingChannelId ? guild.channels.cache.get(cfg.holdingChannelId) : null;
      const lobbyCh = cfg.lobbyChannelIds?.[0] ? guild.channels.cache.get(cfg.lobbyChannelIds[0]) : null;
      const dest = holdingCh || lobbyCh;
      if (dest) {
        try {
          const skipper = guild.members.cache.get(userId);
          if (skipper?.voice?.channelId) await skipper.voice.setChannel(dest);
        } catch (err) { console.error('[hsc:skip] move skipper:', err.message); }
      }
      return interaction.reply({ content: '⏭️ You\'ve been moved to holding. Your match will rotate at the bell.', flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId.startsWith('purge:')) {
    const [, action, amountStr, userId] = interaction.customId.split(':');
    if (action === 'cancel') return interaction.update({ content: '❌ Purge cancelled.', embeds: [], components: [] });
    if (action === 'confirm') {
      const amount = parseInt(amountStr, 10);
      await interaction.update({ content: '🗑️ Deleting messages...', embeds: [], components: [] });
      try {
        let messages = await interaction.channel.messages.fetch({ limit: 100 });
        if (userId !== 'all') messages = messages.filter(m => m.author.id === userId);
        messages = [...messages.values()].slice(0, amount);
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const bulkable = messages.filter(m => m.createdTimestamp > twoWeeksAgo);
        const tooOld   = messages.filter(m => m.createdTimestamp <= twoWeeksAgo);
        let deleted = 0;
        if (bulkable.length >= 2) { await interaction.channel.bulkDelete(bulkable); deleted += bulkable.length; }
        else if (bulkable.length === 1) { await bulkable[0].delete(); deleted++; }
        for (const m of tooOld) { try { await m.delete(); deleted++; } catch {} }
        const warn = tooOld.length > 0 ? `\n⚠️ ${tooOld.length} message(s) older than 14 days deleted one-by-one.` : '';
        await interaction.editReply({ content: `✅ Deleted **${deleted}** message(s).${warn}` });
      } catch (err) {
        console.error('[purge] error:', err);
        await interaction.editReply({ content: `❌ Purge failed: ${err.message}` });
      }
    }
  }

  if (interaction.customId.startsWith('temprole:')) {
    const roleId = interaction.customId.replace('temprole:', '');
    const tr = await loadTR();
    const cfg = tr[interaction.guildId];
    const rule = cfg?.timedRoles?.find(r => r.roleId === roleId);
    if (!rule) return await interaction.reply({ content: '❌ Role not found.', ephemeral: true });
    const member = interaction.member;
    const key = `${interaction.guildId}:${interaction.user.id}:${roleId}`;
    if (timedRoleTimers.has(key)) return await interaction.reply({ content: `⏳ You already have this role. It will expire automatically.`, ephemeral: true });
    await member.roles.add(roleId, `HSC: timed role (${rule.durationMinutes}m)`).catch(() => {});
    await interaction.reply({ content: `✅ You've been given the <@&${roleId}> role for ${rule.durationMinutes} minute(s).`, ephemeral: true });
    const timer = setTimeout(async () => {
      await member.roles.remove(roleId, 'HSC: timed role expired').catch(() => {});
      timedRoleTimers.delete(key);
    }, rule.durationMinutes * 60 * 1000);
    timedRoleTimers.set(key, timer);
  }
});

// ===========================================================================
//  SLASH COMMANDS REGISTRATION
// ===========================================================================
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Open the HIGH-SPEED CONNECTION BOT configuration menu').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('help').setDescription('Show all available HIGH-SPEED CONNECTION BOT commands'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Show info about HIGH-SPEED CONNECTION BOT'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show info about this server'),
  new SlashCommandBuilder().setName('channel-index').setDescription('Post a formatted index of all channels in this server')
    .addStringOption(opt => opt.setName('category').setDescription('Only list channels in this category (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('export-channels').setDescription('Export all channels to a channels.json file'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show profile info for a user, even if they left the server')
    .addUserOption(opt => opt.setName('user').setDescription('The user to look up').setRequired(true)),
  new SlashCommandBuilder().setName('roleinfo').setDescription('Show info about a role')
    .addRoleOption(opt => opt.setName('role').setDescription('The role to look up').setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('Delete messages from this channel (requires Manage Messages)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages to delete (1–100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(opt => opt.setName('user').setDescription('Only delete messages from this user (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('camera-policy').setDescription('Turn the cameras-on voice channel policy on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt => opt.setName('state').setDescription('Turn the policy on or off').setRequired(true).addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })),
  new SlashCommandBuilder().setName('camera-status').setDescription('View the full current camera policy configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('camera-monitor').setDescription('Manage which voice channels enforce the cameras-on policy')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Start monitoring a voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop monitoring a voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List all monitored voice channels')),
  new SlashCommandBuilder().setName('camera-exempt-role').setDescription('Manage roles exempt from the cameras-on policy')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Exempt a role').addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription("Remove a role's exemption").addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List all exempt roles')),
  new SlashCommandBuilder().setName('camera-timing').setDescription('Configure camera policy timing')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('set').setDescription('Set the grace and warning period')
      .addIntegerOption(opt => opt.setName('grace_minutes').setDescription('Silent period before reminder (minutes)').setRequired(true).setMinValue(0).setMaxValue(60))
      .addIntegerOption(opt => opt.setName('warning_minutes').setDescription('Time after reminder before removal (minutes)').setRequired(true).setMinValue(1).setMaxValue(60)))
    .addSubcommand(sub => sub.setName('view').setDescription('View current timing settings')),
  new SlashCommandBuilder().setName('camera-announcement').setDescription('Set a link to your camera policy announcement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('set').setDescription('Set the announcement link').addStringOption(opt => opt.setName('url').setDescription('Link to your policy post').setRequired(true)))
    .addSubcommand(sub => sub.setName('clear').setDescription('Remove the announcement link'))
    .addSubcommand(sub => sub.setName('view').setDescription('View the current announcement link')),
  new SlashCommandBuilder().setName('speed-match').setDescription('High-Speed Connection — VC speed match event')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('start').setDescription('Start the session (runs first round immediately)'))
    .addSubcommand(sub => sub.setName('stop').setDescription('Stop the session and clean up'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show current shuffle configuration and state'))
    .addSubcommand(sub => sub.setName('set-group-size').setDescription('Set members per shuffle group')
      .addIntegerOption(opt => opt.setName('min').setDescription('Min group size').setRequired(true).setMinValue(1).setMaxValue(10))
      .addIntegerOption(opt => opt.setName('max').setDescription('Max group size').setRequired(true).setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub => sub.setName('set-interval').setDescription('Set shuffle interval in minutes')
      .addIntegerOption(opt => opt.setName('min').setDescription('Min minutes').setRequired(true).setMinValue(1).setMaxValue(60))
      .addIntegerOption(opt => opt.setName('max').setDescription('Max minutes').setRequired(true).setMinValue(1).setMaxValue(60)))
    .addSubcommand(sub => sub.setName('add-lobby').setDescription('Add a lobby voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove-lobby').setDescription('Remove a lobby voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-category').setDescription('Set the category for temp rooms').addChannelOption(opt => opt.setName('category').setDescription('Category').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-announce').setDescription('Set announcement text channel').addChannelOption(opt => opt.setName('channel').setDescription('Text channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('shuffle-now').setDescription('Ring the bell and start a new round now'))
    .addSubcommand(sub => sub.setName('end-session').setDescription('End session and post summary'))
    .addSubcommand(sub => sub.setName('set-participant-role').setDescription('Role assigned when someone joins a lobby').addRoleOption(opt => opt.setName('role').setDescription('Participant role').setRequired(true)))
    .addSubcommand(sub => sub.setName('add-staff-role').setDescription('Add a staff role with access to temp rooms').addRoleOption(opt => opt.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove-staff-role').setDescription('Remove a staff role').addRoleOption(opt => opt.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-bot-role').setDescription("Set the bot's managed role").addRoleOption(opt => opt.setName('role').setDescription("Bot's role").setRequired(true)))
    .addSubcommand(sub => sub.setName('set-warning-seconds').setDescription('Seconds before bell to post warning').addIntegerOption(opt => opt.setName('seconds').setDescription('Seconds').setRequired(true).setMinValue(5).setMaxValue(300)))
    .addSubcommand(sub => sub.setName('set-connection-mode').setDescription('Set pairing mode: standard or role-based')
      .addStringOption(opt => opt.setName('mode').setDescription('Mode').setRequired(true)
        .addChoices({ name: 'Standard (1-on-1 anti-repeat)', value: 'standard' }, { name: 'Role-Based (pools)', value: 'role-based' })))
    .addSubcommand(sub => sub.setName('set-holding-channel').setDescription('VC where skipped members wait until the bell').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true))),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('[startup] Slash commands registered globally.');
}

// ===========================================================================
//  MAIN SLASH COMMAND HANDLER
// ===========================================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT — Commands')
        .addFields(
          { name: '📋 General',              value: '`/help` `/botinfo` `/serverinfo` `/userinfo` `/roleinfo` `/purge`', inline: false },
          { name: '# Channel Index',         value: '`/channel-index` `/export-channels`', inline: false },
          { name: '📷 Camera Policy',        value: '`/camera-policy` `/camera-status` `/camera-monitor` `/camera-exempt-role` `/camera-timing` `/camera-announcement`', inline: false },
          { name: '💨 High-Speed Connection',value: '`/speed-match start/stop/status/shuffle-now/end-session`\n`/speed-match set-connection-mode` `/speed-match set-holding-channel` and more', inline: false },
          { name: '⚙️ Admin',                value: '`/setup` — interactive config menu', inline: false },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Made with 🖤' });
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'botinfo') {
      const guilds = client.guilds.cache.size;
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600); const minutes = Math.floor((uptime % 3600) / 60);
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT')
        .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Bot Tag',   value: client.user.tag,           inline: true },
          { name: 'Servers',   value: String(guilds),             inline: true },
          { name: 'Uptime',    value: `${hours}h ${minutes}m`,   inline: true },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Discord Community Management' }).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'serverinfo') {
      const guild = interaction.guild;
      await guild.members.fetch().catch(() => {});
      const bots  = guild.members.cache.filter(m => m.user.bot).size;
      const humans = guild.memberCount - bots;
      const channels = guild.channels.cache;
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle(guild.name)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: 'Owner',        value: `<@${guild.ownerId}>`,                                                          inline: true },
          { name: 'Members',      value: `${humans} humans · ${bots} bots`,                                              inline: true },
          { name: 'Created',      value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,                           inline: true },
          { name: 'Channels',     value: `${channels.filter(c => c.type === ChannelType.GuildText).size} text · ${channels.filter(c => c.type === ChannelType.GuildVoice).size} voice`, inline: true },
          { name: 'Roles',        value: String(guild.roles.cache.size),                                                  inline: true },
          { name: 'Boost Level',  value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`,        inline: true },
          { name: 'Verification', value: guild.verificationLevel.toString(),                                              inline: true },
          { name: 'Server ID',    value: guild.id,                                                                        inline: true },
        );
      if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'export-channels') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = getChannelData(interaction.guild);
      const json = JSON.stringify(data, null, 2);
      const { Readable } = require('stream');
      const stream = Readable.from([json]);
      return interaction.editReply({ content: `Exported ${data.length} channels.`, files: [{ attachment: stream, name: 'channels.json' }] });
    }

    if (interaction.commandName === 'userinfo') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      const fullUser   = await client.users.fetch(targetUser.id, { force: true });
      let member = null;
      try { member = await interaction.guild.members.fetch(targetUser.id); } catch {}
      const embed = new EmbedBuilder()
        .setColor(member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : 0x8a2be2)
        .setTitle(fullUser.username).setThumbnail(fullUser.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User ID',         value: fullUser.id,                                              inline: true },
          { name: 'Display Name',    value: fullUser.globalName || fullUser.username,                  inline: true },
          { name: 'Bot Account',     value: fullUser.bot ? 'Yes' : 'No',                             inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:F>`, inline: false },
        ).setTimestamp();
      if (fullUser.banner) embed.setImage(fullUser.bannerURL({ size: 512 }));
      if (member) {
        embed.addFields(
          { name: 'In This Server', value: 'Yes',                                                   inline: true },
          { name: 'Nickname',       value: member.nickname || '—',                                   inline: true },
          { name: 'Joined Server',  value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`,    inline: false },
        );
        const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name);
        if (roles.length) embed.addFields({ name: `Roles (${roles.length})`, value: roles.join(', ').slice(0, 1024) });
      } else {
        embed.addFields({ name: 'In This Server', value: 'No — showing global profile only', inline: true });
      }
      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'roleinfo') {
      const role = interaction.options.getRole('role');
      await interaction.guild.members.fetch().catch(() => {});
      const memberCount = interaction.guild.members.cache.filter(m => m.roles.cache.has(role.id) && !m.user.bot).size;
      const keyPerms = [
        ['Administrator',    PermissionFlagsBits.Administrator],
        ['Manage Guild',     PermissionFlagsBits.ManageGuild],
        ['Manage Roles',     PermissionFlagsBits.ManageRoles],
        ['Manage Channels',  PermissionFlagsBits.ManageChannels],
        ['Manage Messages',  PermissionFlagsBits.ManageMessages],
        ['Kick Members',     PermissionFlagsBits.KickMembers],
        ['Ban Members',      PermissionFlagsBits.BanMembers],
        ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
        ['Mute Members',     PermissionFlagsBits.MuteMembers],
        ['Move Members',     PermissionFlagsBits.MoveMembers],
      ];
      const activePerms = keyPerms.filter(([, bit]) => role.permissions.has(bit)).map(([name]) => name);
      const embed = new EmbedBuilder().setColor(role.color || 0x8a2be2).setTitle(role.name)
        .addFields(
          { name: 'Role ID',         value: role.id,                                              inline: true },
          { name: 'Color',           value: role.hexColor,                                         inline: true },
          { name: 'Position',        value: String(role.position),                                 inline: true },
          { name: 'Members',         value: String(memberCount),                                   inline: true },
          { name: 'Mentionable',     value: role.mentionable ? 'Yes' : 'No',                      inline: true },
          { name: 'Hoisted',         value: role.hoist ? 'Yes (shown separately)' : 'No',         inline: true },
          { name: 'Managed',         value: role.managed ? 'Yes (bot/integration)' : 'No',        inline: true },
          { name: 'Created',         value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`,  inline: true },
          { name: 'Key Permissions', value: activePerms.length ? activePerms.join(', ') : 'None notable', inline: false },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'purge') {
      const amount     = interaction.options.getInteger('amount');
      const userFilter = interaction.options.getUser('user');
      const confirmEmbed = new EmbedBuilder().setColor(0xff4d6d).setTitle('⚠️ Confirm Message Purge')
        .setDescription(
          `You are about to delete up to **${amount}** message(s) in <#${interaction.channel.id}>` +
          (userFilter ? ` from **${userFilter.tag}**` : '') +
          `.\n\nThis **cannot be undone**. Click Confirm to proceed.`
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`purge:confirm:${amount}:${userFilter?.id || 'all'}`).setLabel('🗑️ Confirm Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('purge:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'camera-policy') {
      const enabled = interaction.options.getString('state') === 'on';
      const saved   = await setCameraPolicyEnabled(interaction.guildId, enabled);
      if (!enabled) clearAllCameraWarningsForGuild(interaction.guildId);
      const saveWarning = saved ? '' : '\n⚠️ **Save failed** — check logs.';
      return interaction.reply({ content: (enabled ? '📷 Camera policy is now **ON**.' : '📴 Camera policy is now **OFF**.') + saveWarning });
    }

    if (interaction.commandName === 'camera-status') {
      const cfg = ensureGuildConfig(interaction.guildId);
      const effectiveIds = getEffectiveMonitoredChannelIds(interaction.guildId, interaction.guild);
      const embed = new EmbedBuilder().setColor(cfg.enabled ? 0x00cc66 : 0x999999).setTitle('📷 Camera Policy Status')
        .addFields(
          { name: 'Enabled',         value: cfg.enabled ? 'Yes' : 'No',                                     inline: true },
          { name: 'Grace period',    value: `${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m`,                 inline: true },
          { name: 'Warning period',  value: `${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m`,             inline: true },
          { name: `Monitored channels (${effectiveIds.size} effective)`, value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map(id => `<#${id}>`).join(', ') : 'None' },
          { name: `Monitored categories (${cfg.monitoredCategoryIds?.length ?? 0})`, value: cfg.monitoredCategoryIds?.length ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'None' },
          { name: `Exempt roles (${cfg.exemptRoles.length})`, value: cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : 'None' },
          { name: 'Announcement link', value: cfg.announcementUrl || 'Not set' },
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'camera-monitor') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** is already monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels.push(ch.id); await saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Now monitoring **#${ch.name}** for the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const ch = interaction.options.getChannel('channel');
        if (!gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** wasn't monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels = gc.monitoredChannels.filter(id => id !== ch.id); await saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Stopped monitoring **#${ch.name}**.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Monitored voice channels:**\n${gc.monitoredChannels.length ? gc.monitoredChannels.map(id => `<#${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === 'camera-exempt-role') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const role = interaction.options.getRole('role');
        if (gc.exemptRoles.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already exempt.`, flags: MessageFlags.Ephemeral });
        gc.exemptRoles.push(role.id); await saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is now exempt from the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const role = interaction.options.getRole('role');
        gc.exemptRoles = gc.exemptRoles.filter(id => id !== role.id); await saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is no longer exempt.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Exempt roles:**\n${gc.exemptRoles.length ? gc.exemptRoles.map(id => `<@&${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === 'camera-timing') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') {
        gc.graceMinutes   = interaction.options.getInteger('grace_minutes');
        gc.warningMinutes = interaction.options.getInteger('warning_minutes');
        await saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Timing updated: **${gc.graceMinutes}m** grace + **${gc.warningMinutes}m** warning = **${gc.graceMinutes + gc.warningMinutes}m** total before removal.`);
      }
      if (sub === 'view') {
        const { graceMinutes, warningMinutes } = getTiming(interaction.guildId);
        return interaction.reply({ content: `**Grace:** ${graceMinutes}m\n**Warning:** ${warningMinutes}m\n**Total:** ${graceMinutes + warningMinutes}m`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === 'camera-announcement') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') { gc.announcementUrl = interaction.options.getString('url'); await saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link set.'); }
      if (sub === 'clear') { gc.announcementUrl = null; await saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link cleared.'); }
      if (sub === 'view') { return interaction.reply({ content: gc.announcementUrl ? `Current link:\n${gc.announcementUrl}` : 'No link set.', flags: MessageFlags.Ephemeral }); }
    }

    if (interaction.commandName === 'channel-index') {
      await interaction.deferReply();
      const categoryFilter = interaction.options.getString('category');
      const data = getChannelData(interaction.guild, categoryFilter);
      const indexCfg = ensureChannelIndexGuildConfig(interaction.guildId);
      const descriptions = loadDescriptions(interaction.guildId);
      const byCategory = {};
      for (const ch of data) {
        if (ch.categoryId && indexCfg.excludedCategoryIds.includes(ch.categoryId)) continue;
        if (indexCfg.excludedChannelIds.includes(ch.id)) continue;
        const nameLower = ch.name.toLowerCase();
        if (indexCfg.excludedNameKeywords.some(kw => nameLower.includes(kw))) continue;
        const key = ch.category || 'No Category';
        if (!byCategory[key]) byCategory[key] = [];
        byCategory[key].push(ch);
      }
      const MAX_FIELDS = 25; const MAX_CHARS = 5500;
      const embeds = []; let current = null; let fieldCount = 0; let charCount = 0; let isFirst = true;
      const startNewEmbed = () => {
        const e = new EmbedBuilder().setColor(0x8a2be2);
        if (isFirst) { e.setTitle(categoryFilter ? `Channel Index — ${categoryFilter}` : 'Channel Index').setTimestamp(); isFirst = false; }
        return e;
      };
      current = startNewEmbed();
      for (const [category, chans] of Object.entries(byCategory)) {
        const lines = chans.map(ch => {
          const desc = descriptions[ch.id]?.description?.trim();
          return `[${desc ? `**#${ch.name}** — ${desc}` : `**#${ch.name}**`}](${ch.link})`;
        });
        const value = lines.join('\n').slice(0, 1024) || '—';
        if (fieldCount >= MAX_FIELDS || charCount + category.length + value.length > MAX_CHARS) {
          embeds.push(current); current = startNewEmbed(); fieldCount = 0; charCount = 0;
        }
        current.addFields({ name: category, value }); fieldCount++; charCount += category.length + value.length;
      }
      embeds.push(current);
      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
    }

    if (interaction.commandName === 'speed-match') {
      const sub = interaction.options.getSubcommand();
      const guild = interaction.guild; const cfg = ensureVcShuffleGuildConfig(interaction.guildId);

      if (sub === 'start') {
        if (!cfg.lobbyChannelIds.length) return interaction.reply({ content: '❌ Add a lobby channel first with `/speed-match add-lobby`.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply(); await startVcShuffle(guild, interaction.guildId, true);
        const state = shuffleState.get(interaction.guildId);
        const nextIn = state?.nextShuffleAt ? Math.round((state.nextShuffleAt - Date.now()) / 1000 / 60) : '?';
        return interaction.editReply(`🔀 **Session started!** First round complete. Next shuffle in ~${nextIn}m.`);
      }
      if (sub === 'stop' || sub === 'end-session') {
        await interaction.deferReply(); await stopVcShuffle(guild, interaction.guildId);
        return interaction.editReply('⏹️ **Session ended.** Everyone moved to lobby, summary posted.');
      }
      if (sub === 'shuffle-now') {
        await interaction.deferReply();
        const state = shuffleState.get(interaction.guildId);
        if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
        await postBellMessage(guild, interaction.guildId);
        await runShuffleRound(guild, interaction.guildId);
        scheduleNextShuffle(guild, interaction.guildId);
        return interaction.editReply('🔔 **Bell rung!** Everyone moved. Timer reset.');
      }
      if (sub === 'status') {
        const state = shuffleState.get(interaction.guildId);
        const nextIn = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : 'N/A';
        const modeLabel = cfg.connectionMode === 'role-based' ? 'Role-Based' : (cfg.minGroupSize === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
        const embed = new EmbedBuilder().setColor(cfg.enabled ? 0x8a2be2 : 0x999999).setTitle('💨 High-Speed Connection — Status')
          .addFields(
            { name: 'Running',          value: cfg.enabled ? '🟢 Yes' : '🔴 No',       inline: true },
            { name: 'Round #',          value: String(state?.roundNumber ?? 0),          inline: true },
            { name: 'Next bell',        value: cfg.enabled ? nextIn : 'Not scheduled',  inline: true },
            { name: 'Mode',             value: modeLabel,                                inline: true },
            { name: 'Round length',     value: `${cfg.minIntervalMinutes}m`,             inline: true },
            { name: 'Warn before bell', value: `${cfg.warningSeconds ?? 30}s`,           inline: true },
            { name: 'Unique pairs',     value: String(state?.pairHistory?.size ?? 0),    inline: true },
            { name: 'Unique skips',     value: String(state?.skipHistory?.size ?? 0),    inline: true },
            { name: 'Active rooms',     value: String(cfg.createdChannelIds.length),     inline: true },
            { name: 'Lobbies',          value: cfg.lobbyChannelIds.length ? cfg.lobbyChannelIds.map(id => `<#${id}>`).join(', ') : 'None', inline: false },
            { name: 'Holding channel',  value: cfg.holdingChannelId ? `<#${cfg.holdingChannelId}>` : 'Not set (falls back to lobby)', inline: false },
          );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (sub === 'set-group-size') {
        const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
        if (min > max) return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
        cfg.minGroupSize = min; cfg.maxGroupSize = max; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Group size set to **${min}–${max}** per room.`);
      }
      if (sub === 'set-interval') {
        const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
        if (min > max) return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
        cfg.minIntervalMinutes = min; cfg.maxIntervalMinutes = max; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Interval set to **${min}–${max}** minutes.`);
      }
      if (sub === 'add-lobby') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (cfg.lobbyChannelIds.includes(ch.id)) return interaction.reply({ content: `**${ch.name}** is already a lobby.`, flags: MessageFlags.Ephemeral });
        cfg.lobbyChannelIds.push(ch.id); await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** added as a lobby channel.`);
      }
      if (sub === 'remove-lobby') {
        const ch = interaction.options.getChannel('channel');
        cfg.lobbyChannelIds = cfg.lobbyChannelIds.filter(id => id !== ch.id); await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** removed from lobby channels.`);
      }
      if (sub === 'set-category') {
        const ch = interaction.options.getChannel('category');
        if (ch.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ Must be a category.', flags: MessageFlags.Ephemeral });
        cfg.categoryId = ch.id; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Temp rooms will be created inside **${ch.name}**.`);
      }
      if (sub === 'set-announce') {
        const ch = interaction.options.getChannel('channel');
        cfg.announcementChannelId = ch.id; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Announcements will post in <#${ch.id}>.`);
      }
      if (sub === 'set-participant-role') {
        cfg.participantRoleId = interaction.options.getRole('role').id; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${interaction.options.getRole('role').name}** set as participant role.`);
      }
      if (sub === 'add-staff-role') {
        const role = interaction.options.getRole('role');
        if (!cfg.staffRoleIds) cfg.staffRoleIds = [];
        if (cfg.staffRoleIds.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already a staff role.`, flags: MessageFlags.Ephemeral });
        cfg.staffRoleIds.push(role.id); await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** added to staff roles.`);
      }
      if (sub === 'remove-staff-role') {
        const role = interaction.options.getRole('role');
        cfg.staffRoleIds = (cfg.staffRoleIds || []).filter(id => id !== role.id); await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** removed from staff roles.`);
      }
      if (sub === 'set-bot-role') {
        cfg.botRoleId = interaction.options.getRole('role').id; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Bot role set to **${interaction.options.getRole('role').name}**.`);
      }
      if (sub === 'set-warning-seconds') {
        cfg.warningSeconds = interaction.options.getInteger('seconds'); await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Warning fires **${cfg.warningSeconds}s** before the bell.`);
      }
      if (sub === 'set-connection-mode') {
        const mode = interaction.options.getString('mode');
        cfg.connectionMode = mode; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Connection mode set to **${mode === 'role-based' ? 'Role-Based' : 'Standard'}**.`);
      }
      if (sub === 'set-holding-channel') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        cfg.holdingChannelId = ch.id; await saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Holding channel set to **${ch.name}**.`);
      }
    }

  } catch (err) {
    console.error('[command] error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply('Something went wrong — check the terminal.');
      else await interaction.reply({ content: 'Something went wrong — check the terminal.', flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

// ===========================================================================
//  STARTUP — connect DB first, then start bot + web server
// ===========================================================================
async function main() {
  await connectDB();
  await Promise.all([
    loadCameraConfig(),
    loadChannelIndexConfig(),
    loadAllDescriptions(),
    loadVcShuffleConfig(),
  ]);
  console.log('[startup] All configs loaded from MongoDB');

  client.once('clientReady', async () => {
    console.log(`[startup] Logged in as ${client.user.tag}`);
    await registerCommands();
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      await guild.channels.fetch().catch(() => {});
      await ensureDescriptionsLoaded(guild);
    }
  });

  client.on('error', err => console.error('[discord] client error:', err));
  process.on('unhandledRejection', err => console.error('[process] unhandledRejection:', err));

  client.login(TOKEN);
  startWebServer();
}

// ===========================================================================
//  WEB DASHBOARD — OAuth2 + Express
// ===========================================================================
const express = require('express');
const session = require('express-session');

const PORT                  = process.env.PORT || 3000;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET        = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const REDIRECT_URI          = process.env.DISCORD_REDIRECT_URI || 'https://your-app.onrender.com/auth/callback';
const DASHBOARD_URL         = process.env.DASHBOARD_URL || 'https://your-app.onrender.com';

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)
  console.warn('[dashboard] DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET not set — OAuth login will fail.');
if (!process.env.SESSION_SECRET)
  console.warn('[dashboard] SESSION_SECRET not set — sessions reset on every restart.');

const isProduction = process.env.NODE_ENV === 'production';

// ===========================================================================
//  STICKY POSTS
// ===========================================================================
let stickyCache = {};
async function loadSticky() {
  const val = await dbGet('sticky_posts');
  stickyCache = val || {};
  return stickyCache;
}
async function saveSticky(d) {
  stickyCache = d;
  return dbSet('sticky_posts', d);
}

const stickyLastMsg = {};
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const gSticky = stickyCache[msg.guildId]; if (!gSticky) return;
  const entry = gSticky[msg.channelId]; if (!entry?.content) return;
  try {
    if (stickyLastMsg[msg.channelId]) { const old = await msg.channel.messages.fetch(stickyLastMsg[msg.channelId]).catch(()=>null); if (old) await old.delete().catch(()=>{}); }
    const sent = await msg.channel.send({ content:`📌 ${entry.content}` }); stickyLastMsg[msg.channelId] = sent.id;
  } catch {}
});

// ===========================================================================
//  AUTO RESPONDERS
// ===========================================================================
let arCache = {};
async function loadAR() {
  const val = await dbGet('autoresponders');
  arCache = val || {};
  return arCache;
}
async function saveAR(d) {
  arCache = d;
  return dbSet('autoresponders', d);
}

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guildId) return;
  const gAR = arCache[msg.guildId]; if (!gAR?.length) return;
  const lower = msg.content.toLowerCase();
  for (const rule of gAR) {
    const match = rule.matchType==='exact' ? lower===rule.trigger.toLowerCase() : lower.includes(rule.trigger.toLowerCase());
    if (match) { await msg.channel.send(rule.response).catch(()=>{}); break; }
  }
});

// ===========================================================================
//  TEMP ROLES
// ===========================================================================
let tempRolesCache = {};
async function loadTR() {
  const val = await dbGet('temp_roles');
  tempRolesCache = val || {};
  return tempRolesCache;
}
async function saveTR(d) {
  tempRolesCache = d;
  return dbSet('temp_roles', d);
}

const timedRoleTimers = new Map();

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const cfg = tempRolesCache[guildId];
  if (!cfg?.vcRoleId) return;
  const guild = newState.guild || oldState.guild;
  const monitored = cfg.monitoredChannelIds?.length ? cfg.monitoredChannelIds : null;
  const justJoined = !oldState.channelId && !!newState.channelId;
  const justLeft   = !!oldState.channelId && !newState.channelId;
  const switched   = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;

  async function postJoinMessage(member, vcChannel) {
    if (!member || member.user.bot) return;
    const tagRoleIds = cfg.tagRoleIds?.length ? cfg.tagRoleIds : [];
    const roleMentions = tagRoleIds.map(id => `<@&${id}>`).join(' ');
    const buildMsg = (custom) => custom
      ? custom.replace(/{user}/g,`${member}`).replace(/{channel}/g,vcChannel?.name||'').replace(/{mention}/g,`<#${vcChannel?.id}>`).replace(/{roles}/g,roleMentions)
      : `🔊 ${member} joined **${vcChannel?.name || 'a voice channel'}**${roleMentions ? ` · ${roleMentions}` : ''}`;
    const nonBotSize = vcChannel?.members?.filter(m => !m.user.bot).size ?? 0;
    const isNewlyActive = nonBotSize === 1;
    if (cfg.vcTextChannelId) {
      const vcText = guild.channels.cache.get(cfg.vcTextChannelId);
      if (vcText) await vcText.send(buildMsg(cfg.announceMsg)).catch(() => {});
    }
    if (cfg.announceChannelId && isNewlyActive) {
      const announceChannel = guild.channels.cache.get(cfg.announceChannelId);
      if (announceChannel) await announceChannel.send(buildMsg(cfg.announceMsg)).catch(() => {});
    }
  }

  if (justJoined) {
    const member = newState.member;
    if (member && !member.user.bot) {
      const ch = newState.channel;
      if (!monitored || monitored.includes(ch?.id)) {
        await member.roles.add(cfg.vcRoleId, 'HSC: joined VC').catch(() => {});
        await postJoinMessage(member, ch);
      }
    }
  }
  if (switched) {
    const member = newState.member;
    if (member && !member.user.bot) {
      const newCh = newState.channel;
      if (!monitored || monitored.includes(newCh?.id)) {
        const nonBotSize = newCh?.members?.filter(m => !m.user.bot).size ?? 0;
        if (nonBotSize === 1) await postJoinMessage(member, newCh);
      }
      if (monitored && !monitored.includes(newCh?.id) && monitored.includes(oldState.channelId))
        await member.roles.remove(cfg.vcRoleId, 'HSC: left monitored VC').catch(() => {});
      if (monitored && monitored.includes(newCh?.id) && !monitored.includes(oldState.channelId))
        await member.roles.add(cfg.vcRoleId, 'HSC: entered monitored VC').catch(() => {});
    }
  }
  if (justLeft) {
    const member = oldState.member;
    if (member && !member.user.bot) {
      if (!monitored || monitored.includes(oldState.channelId))
        await member.roles.remove(cfg.vcRoleId, 'HSC: left VC').catch(() => {});
    }
  }
});

// ===========================================================================
//  EXPRESS WEB SERVER
// ===========================================================================
function startWebServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: true, limit: '3mb' }));
  app.use(express.json({ limit: '3mb' }));
  // In-memory sessions — fine for Render (users just re-login after a restart)
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
  }));

  async function exchangeCode(code) {
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    const res = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    return res.json();
  }

  function requireAuth(req, res, next) {
    if (req.session?.userId) return next();
    return res.redirect('/login');
  }

  function resolveGuildId(req) {
    const qg = req.query.guild || req.body?.guild;
    const allowed = req.session?.allowedGuildIds || [];
    if (qg && allowed.includes(qg)) return qg;
    return allowed[0] || null;
  }

  // ── shared CSS ─────────────────────────────────────────────────────────
  const DASH_CSS = `
  <style>
    :root {
      --magenta:#FF00FF; --magenta-dim:#cc00cc; --magenta-glow:rgba(255,0,255,0.35);
      --magenta-faint:rgba(255,0,255,0.08); --bg:#080808; --surface:#111;
      --surface2:#181818; --border:rgba(255,0,255,0.2); --text:#e0e0e0; --muted:#888;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html{scroll-behavior:smooth;}
    body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;font-size:15px;line-height:1.6;min-height:100vh;}
    body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px);pointer-events:none;z-index:999;}
    a{color:var(--magenta);text-decoration:none;}
    a:hover{text-decoration:underline;}
    nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:.75rem 2rem;background:rgba(8,8,8,0.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);}
    .nav-logo{font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:.1em;color:var(--magenta);text-shadow:0 0 12px var(--magenta-glow);}
    .nav-links{display:flex;gap:1.5rem;list-style:none;align-items:center;}
    .nav-links a{color:var(--muted);font-size:.8rem;font-weight:500;letter-spacing:.05em;text-transform:uppercase;transition:color .2s;}
    .nav-links a:hover,.nav-links a.active{color:var(--magenta);}
    .nav-user{font-size:.8rem;color:var(--muted);}
    .layout{display:flex;padding-top:56px;min-height:100vh;}
    .sidebar{width:220px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);padding:1.5rem 0;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto;}
    .sidebar-section{padding:.25rem 1rem .5rem;font-size:.65rem;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-top:1rem;}
    .sidebar a{display:block;padding:.5rem 1.25rem;font-size:.85rem;color:var(--muted);border-left:2px solid transparent;transition:all .15s;}
    .sidebar a:hover,.sidebar a.active{color:var(--magenta);border-left-color:var(--magenta);background:var(--magenta-faint);text-decoration:none;}
    .main{flex:1;padding:2rem;max-width:900px;}
    .page-title{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:.08em;color:var(--magenta);text-shadow:0 0 20px var(--magenta-glow);margin-bottom:.25rem;}
    .page-sub{color:var(--muted);font-size:.85rem;margin-bottom:2rem;}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.5rem;margin-bottom:1.25rem;}
    .card-title{font-size:.7rem;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--magenta);margin-bottom:1rem;}
    .form-row{display:flex;flex-direction:column;gap:.4rem;margin-bottom:1rem;}
    .form-row label{font-size:.8rem;color:var(--muted);font-weight:500;}
    input[type=text],input[type=number],select,textarea{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:.5rem .75rem;border-radius:4px;font-size:.9rem;width:100%;font-family:inherit;transition:border-color .2s;}
    input:focus,select:focus,textarea:focus{outline:none;border-color:var(--magenta);}
    textarea{resize:vertical;min-height:80px;}
    .btn{display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.25rem;border-radius:4px;font-weight:600;font-size:.85rem;cursor:pointer;border:none;transition:all .2s;letter-spacing:.03em;font-family:inherit;}
    .btn-primary{background:var(--magenta);color:#000;box-shadow:0 0 15px var(--magenta-glow);}
    .btn-primary:hover{background:#ff33aa;box-shadow:0 0 25px rgba(255,0,255,.6);}
    .btn-ghost{border:1px solid var(--border);color:var(--text);background:transparent;}
    .btn-ghost:hover{border-color:var(--magenta);color:var(--magenta);}
    .btn-danger{background:#c0392b;color:#fff;}
    .btn-danger:hover{background:#e74c3c;}
    .toggle{display:flex;align-items:center;gap:.75rem;}
    .toggle input[type=checkbox]{width:36px;height:20px;appearance:none;background:var(--border);border-radius:10px;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0;}
    .toggle input[type=checkbox]:checked{background:var(--magenta);}
    .toggle input[type=checkbox]::after{content:'';position:absolute;width:14px;height:14px;background:#fff;border-radius:50%;top:3px;left:3px;transition:left .2s;}
    .toggle input[type=checkbox]:checked::after{left:19px;}
    .toggle label{font-size:.9rem;cursor:pointer;}
    .flash{padding:.75rem 1rem;border-radius:4px;margin-bottom:1.25rem;font-size:.85rem;}
    .flash-ok{background:rgba(0,255,100,.08);border:1px solid rgba(0,255,100,.3);color:#00ff64;}
    .flash-err{background:rgba(255,0,0,.08);border:1px solid rgba(255,0,0,.3);color:#ff6464;}
    table{width:100%;border-collapse:collapse;font-size:.85rem;}
    th{text-align:left;padding:.5rem .75rem;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);}
    td{padding:.6rem .75rem;border-bottom:1px solid rgba(255,0,255,.07);}
    tr:last-child td{border-bottom:none;}
    .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:.4rem;}
    .status-on{background:#00ff64;}
    .status-off{background:var(--muted);}
    @media(max-width:700px){.sidebar{display:none;}.main{padding:1rem;}}
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
`;

  function renderLayout({ title, guildId, currentPath, allowedGuildIds, body, username }) {
    const guildOptions = allowedGuildIds.map(id => {
      const g = client.guilds.cache.get(id);
      return `<option value="${id}" ${id === guildId ? 'selected' : ''}>${g ? g.name : id}</option>`;
    }).join('');
    const navItems = [
      ['/', 'Overview'], ['/camera', 'Camera Policy'], ['/channel-index', 'Channel Index'],
      ['/speed-match', 'Speed Match'], ['/sticky', 'Sticky Posts'],
      ['/autoresponder', 'Auto Responders'], ['/temproles', 'Temp Roles'],
    ];
    const sidebarLinks = navItems.map(([href, label]) =>
      `<a href="${href}${guildId ? '?guild='+guildId : ''}" ${currentPath === href ? 'class="active"' : ''}>${label}</a>`
    ).join('');
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — HIGH-SPEED DASHBOARD</title>
${DASH_CSS}
</head><body>
<nav>
  <span class="nav-logo">⚙️ HIGH-SPEED DASHBOARD</span>
  <ul class="nav-links">
    <li class="nav-user">👤 ${username || 'Unknown'}</li>
    <li><a href="/logout">Log out</a></li>
  </ul>
</nav>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-section">Server</div>
    <div style="padding:.35rem .75rem .6rem;">
      <select onchange="location.href=window.location.pathname+'?guild='+this.value" style="width:100%;">
        ${guildOptions || `<option value="${guildId}">${client.guilds.cache.get(guildId)?.name || guildId}</option>`}
      </select>
    </div>
    <div class="sidebar-section">Pages</div>
    ${sidebarLinks}
    <div class="sidebar-section">Legal</div>
    <a href="/tos${guildId ? '?guild='+guildId : ''}">Terms of Service</a>
    <a href="/privacy${guildId ? '?guild='+guildId : ''}">Privacy Policy</a>
  </div>
  <div class="main">
    ${body}
  </div>
</div>
</body></html>`;
  }

  // ── auth routes ───────────────────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (req.session?.userId) return res.redirect('/');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.save(err => {
      if (err) console.error('[auth] session save error:', err);
      const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify guilds', state });
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LOGIN</title>${DASH_CSS}</head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;">
  <div style="text-align:center;max-width:400px;">
    <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;color:var(--magenta);margin-bottom:.5rem;">HIGH-SPEED CONNECTION</div>
    <div style="color:var(--muted);font-size:.9rem;margin-bottom:2rem;">Log in with Discord to manage your servers.</div>
    <a href="https://discord.com/oauth2/authorize?${params.toString()}" class="btn btn-primary" style="font-size:1rem;padding:.75rem 2rem;">🔐 Log in with Discord</a>
  </div>
</div></body></html>`);
    });
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || state !== req.session.oauthState) return res.redirect('/login');
    try {
      const tokenData = await exchangeCode(code);
      if (!tokenData.access_token) return res.redirect('/login');
      const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      const user = await userRes.json();
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      const guilds = await guildsRes.json();
      const ADMIN = 0x8;
      const allowedGuildIds = (Array.isArray(guilds) ? guilds : [])
        .filter(g => (parseInt(g.permissions) & ADMIN) === ADMIN && client.guilds.cache.has(g.id))
        .map(g => g.id);
      req.session.userId = user.id;
      req.session.userTag = user.username;
      req.session.allowedGuildIds = allowedGuildIds;
      req.session.oauthState = null;
      req.session.save(err => {
        if (err) { console.error('[auth] session save error:', err); return res.redirect('/login'); }
        res.redirect('/');
      });
    } catch (err) { console.error('[auth] callback error:', err); res.redirect('/login'); }
  });

  app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });
  app.get('/health', (req, res) => res.status(200).send('ok'));
  app.use(requireAuth);

  // ── overview ──────────────────────────────────────────────────────────
  app.get('/', async (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.send(renderLayout({ title: 'Overview', guildId: null, currentPath: '/', allowedGuildIds, username: req.session.userTag,
      body: `<div class="card"><p>No servers found. Make sure the bot is installed in a server where you have Administrator.</p></div>` }));
    const guild = client.guilds.cache.get(guildId);
    const camCfg = cameraConfig[guildId] || {};
    const vcCfg  = vcShuffleConfig[guildId] || {};
    const body = `
      <div class="page-title">OVERVIEW</div>
      <div class="page-sub">Welcome back, ${req.session.userTag}</div>
      <div class="card">
        <div class="card-title">Server Stats</div>
        <table>
          <tr><td>Server</td><td><strong>${guild?.name || guildId}</strong></td></tr>
          <tr><td>Members</td><td>${guild?.memberCount ?? '—'}</td></tr>
          <tr><td>Camera Policy</td><td><span class="status-dot ${camCfg.enabled ? 'status-on' : 'status-off'}"></span>${camCfg.enabled ? 'Enabled' : 'Disabled'}</td></tr>
          <tr><td>Speed Match</td><td><span class="status-dot ${vcCfg.enabled ? 'status-on' : 'status-off'}"></span>${vcCfg.enabled ? 'Running' : 'Idle'}</td></tr>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">
        ${[['Camera Policy','/camera'],['Channel Index','/channel-index'],['Speed Match','/speed-match'],['Sticky Posts','/sticky'],['Auto Responders','/autoresponder'],['Temp Roles','/temproles']]
          .map(([label, href]) => `<a href="${href}?guild=${guildId}" style="text-decoration:none;"><div class="card" style="text-align:center;padding:1.25rem;cursor:pointer;" onmouseover="this.style.borderColor='var(--magenta)'" onmouseout="this.style.borderColor=''"><div style="font-size:1.5rem;margin-bottom:.5rem">${{'/camera':'📷','/channel-index':'📋','/speed-match':'💨','/sticky':'📌','/autoresponder':'🤖','/temproles':'🎭'}[href]}</div><div style="font-size:.8rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)">${label}</div></div></a>`)
          .join('')}
      </div>`;
    res.send(renderLayout({ title: 'Overview', guildId, currentPath: '/', allowedGuildIds, username: req.session.userTag, body }));
  });

  // ── camera policy ─────────────────────────────────────────────────────
  app.get('/camera', (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const cfg = cameraConfig[guildId] || {};
    const guild = client.guilds.cache.get(guildId);
    const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const categories    = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildCategory).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const textChannels  = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const roles         = guild ? [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a,b) => b.position - a.position) : [];
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const monitored     = cfg.monitoredChannels || [];
    const monitoredCats = cfg.monitoredCategoryIds || [];
    const exempt        = cfg.exemptRoles || [];

    const searchScript = `<script>function flist(inp,listId){const v=inp.value.toLowerCase();document.querySelectorAll('#'+listId+' label').forEach(l=>{l.style.display=l.textContent.toLowerCase().includes(v)?'':'none';});}</script>`;
    const optList = (id, items, checked, nameOf) => `
      <input type="text" placeholder="Search..." oninput="flist(this,'${id}')" style="margin-bottom:.4rem;">
      <div id="${id}" style="max-height:190px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">
        ${items.map(i => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;">
          <input type="checkbox" name="${id.split('-')[0]}" value="${i.id}" ${checked.includes(i.id)?'checked':''}> ${nameOf(i)}
        </label>`).join('')}
      </div>`;

    const body = `${searchScript}
      <div class="page-title">CAMERA POLICY</div>
      <div class="page-sub">Enforce camera-on rules in voice channels.</div>
      ${flash}
      <form method="POST" action="/camera/save/status?guild=${guildId}">
        <div class="card"><div class="card-title">Status</div>
          <div class="toggle"><input type="checkbox" id="enabled" name="enabled" ${cfg.enabled?'checked':''}><label for="enabled">Camera policy enabled</label></div>
          <div style="margin-top:1rem;"><button type="submit" class="btn btn-primary">💾 Save Status</button></div>
        </div>
      </form>
      <form method="POST" action="/camera/save/timing?guild=${guildId}">
        <div class="card"><div class="card-title">Timing</div>
          <div class="form-row"><label>Grace period (minutes) — silent, no message</label><input type="number" name="graceMinutes" value="${cfg.graceMinutes??2}" min="0" max="60"></div>
          <div class="form-row"><label>Warning period (minutes) — after reminder is sent</label><input type="number" name="warningMinutes" value="${cfg.warningMinutes??3}" min="1" max="60"></div>
          <button type="submit" class="btn btn-primary">💾 Save Timing</button>
        </div>
      </form>
      <form method="POST" action="/camera/save/announcement?guild=${guildId}">
        <div class="card"><div class="card-title">Announcement</div>
          <div class="form-row"><label>Announcement channel</label>
            <select name="announcementChannelId"><option value="">— no channel —</option>
              ${textChannels.map(c=>`<option value="${c.id}" ${cfg.announcementChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-row"><label>Announcement post URL (optional)</label>
            <input type="text" name="announcementUrl" value="${cfg.announcementUrl||''}" placeholder="https://discord.com/channels/...">
          </div>
          <button type="submit" class="btn btn-primary">💾 Save Announcement</button>
        </div>
      </form>
      <form method="POST" action="/camera/save/channels?guild=${guildId}">
        <div class="card"><div class="card-title">Monitored Voice Channels &amp; Categories</div>
          <div class="form-row"><label>Voice Channels</label>
            ${optList('monitoredChannels-vc', voiceChannels, monitored, c => `🔊 ${c.name}${c.parent?' <span style="opacity:.5;font-size:.75rem;">('+c.parent.name+')</span>':''}`)}
          </div>
          <div class="form-row"><label>Categories — monitors all voice channels inside</label>
            ${optList('monitoredCategoryIds-cat', categories, monitoredCats, c => `📁 ${c.name}`)}
          </div>
          <button type="submit" class="btn btn-primary">💾 Save Monitored Channels</button>
        </div>
      </form>
      <form method="POST" action="/camera/save/roles?guild=${guildId}">
        <div class="card"><div class="card-title">Exempt Roles</div>
          <div class="form-row">${optList('exemptRoles-roles', roles, exempt, r => `@${r.name}`)}</div>
          <button type="submit" class="btn btn-primary">💾 Save Exempt Roles</button>
        </div>
      </form>`;
    res.send(renderLayout({ title:'Camera Policy', guildId, currentPath:'/camera', allowedGuildIds, username:req.session.userTag, body }));
  });

  app.post('/camera/save/status', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    ensureGuildConfig(guildId); cameraConfig[guildId].enabled = req.body.enabled === 'on';
    await saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Status saved.')}`);
  });
  app.post('/camera/save/timing', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    ensureGuildConfig(guildId); cameraConfig[guildId].graceMinutes = parseInt(req.body.graceMinutes)||2; cameraConfig[guildId].warningMinutes = parseInt(req.body.warningMinutes)||3;
    await saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Timing saved.')}`);
  });
  app.post('/camera/save/announcement', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    ensureGuildConfig(guildId); cameraConfig[guildId].announcementChannelId = req.body.announcementChannelId || null; cameraConfig[guildId].announcementUrl = req.body.announcementUrl?.trim() || null;
    await saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Announcement saved.')}`);
  });
  app.post('/camera/save/channels', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    ensureGuildConfig(guildId);
    const mc = req.body['monitoredChannels-vc'] || req.body.monitoredChannels;
    const mcat = req.body['monitoredCategoryIds-cat'] || req.body.monitoredCategoryIds;
    cameraConfig[guildId].monitoredChannels    = mc   ? (Array.isArray(mc)   ? mc   : [mc])   : [];
    cameraConfig[guildId].monitoredCategoryIds = mcat ? (Array.isArray(mcat) ? mcat : [mcat]) : [];
    await saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Monitored channels saved.')}`);
  });
  app.post('/camera/save/roles', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    ensureGuildConfig(guildId);
    const er = req.body['exemptRoles-roles'] || req.body.exemptRoles;
    cameraConfig[guildId].exemptRoles = er ? (Array.isArray(er) ? er : [er]) : [];
    await saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Exempt roles saved.')}`);
  });

  // ── channel index ─────────────────────────────────────────────────────
  app.get('/channel-index', (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const guild = client.guilds.cache.get(guildId);
    const indexCfg = ensureChannelIndexGuildConfig(guildId);
    const descriptions = loadDescriptions(guildId);
    const textChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const allChannels  = guild ? [...guild.channels.cache.values()].filter(c => c.type !== ChannelType.GuildCategory).sort((a,b) => a.rawPosition - b.rawPosition) : [];
    const byCategory = {};
    for (const ch of allChannels) {
      const cat = ch.parent?.name || 'No Category';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(ch);
    }
    const channelRows = Object.entries(byCategory).map(([cat, chs]) => {
      const rows = chs.map(ch => {
        const excluded = indexCfg.excludedChannelIds?.includes(ch.id);
        const desc = descriptions[ch.id]?.description || '';
        const icon = ch.type === ChannelType.GuildVoice ? '🔊' : ch.type === ChannelType.GuildForum ? '📋' : '#';
        return `<tr>
          <td style="width:32px;text-align:center;"><input type="checkbox" name="includedChannels" value="${ch.id}" ${!excluded?'checked':''}></td>
          <td style="white-space:nowrap">${icon} ${ch.name}</td>
          <td><input type="text" name="desc_${ch.id}" value="${desc.replace(/"/g,'&quot;')}" placeholder="Channel description..." style="padding:.3rem .5rem;font-size:.82rem;"></td>
        </tr>`;
      }).join('');
      return `<tr><td colspan="3" style="background:var(--surface2);padding:.35rem .75rem;font-size:.7rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);">📁 ${cat}</td></tr>${rows}`;
    }).join('');
    const body = `
      <div class="page-title">CHANNEL INDEX</div>
      <div class="page-sub">Post a formatted clickable channel index.</div>
      ${flash}
      <form method="POST" action="/channel-index/post?guild=${guildId}">
        <div class="card"><div class="card-title">Post Channel Index</div>
          <div class="form-row"><label>Post to channel</label>
            <select name="targetChannelId"><option value="">— select a channel —</option>
              ${textChannels.map(c=>`<option value="${c.id}">#${c.name}</option>`).join('')}
            </select>
          </div>
          <button type="submit" class="btn btn-primary">📋 Post Channel Index</button>
        </div>
      </form>
      <form method="POST" action="/channel-index/save-descriptions?guild=${guildId}">
        <div class="card"><div class="card-title">Channels &amp; Descriptions</div>
          <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">✓ = included in index.</p>
          <table><thead><tr><th style="width:32px;text-align:center;">✓</th><th>Channel</th><th>Description</th></tr></thead><tbody>${channelRows}</tbody></table>
          <div style="margin-top:1rem;"><button type="submit" class="btn btn-primary">💾 Save Descriptions &amp; Visibility</button></div>
        </div>
      </form>`;
    res.send(renderLayout({ title:'Channel Index', guildId, currentPath:'/channel-index', allowedGuildIds, username:req.session.userTag, body }));
  });

  app.post('/channel-index/save-descriptions', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const guild = client.guilds.cache.get(guildId);
    const allChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type !== ChannelType.GuildCategory) : [];
    const all = { ...descriptionsCache };
    if (!all[guildId]) all[guildId] = {};
    for (const ch of allChannels) {
      const desc = req.body[`desc_${ch.id}`] || '';
      all[guildId][ch.id] = { name: ch.name, description: desc.trim() };
    }
    await saveAllDescriptions(all);
    const included = (() => { const v = req.body.includedChannels; return v ? (Array.isArray(v)?v:[v]) : []; })();
    const excluded = allChannels.map(c=>c.id).filter(id=>!included.includes(id));
    ensureChannelIndexGuildConfig(guildId).excludedChannelIds = excluded;
    await saveChannelIndexConfig(channelIndexConfig);
    res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('✅ Descriptions and visibility saved.')}`);
  });

  app.post('/channel-index/post', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const targetChannelId = req.body.targetChannelId;
    if (!targetChannelId) return res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('❌ Select a channel to post to.')}`);
    try {
      const guild = await client.guilds.fetch(guildId); await guild.channels.fetch();
      const targetCh = guild.channels.cache.get(targetChannelId);
      if (!targetCh) return res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('❌ Channel not found.')}`);
      const data = getChannelData(guild);
      const indexCfg = ensureChannelIndexGuildConfig(guildId);
      const descriptions = loadDescriptions(guildId);
      const byCategory = {};
      for (const ch of data) {
        if (indexCfg.excludedCategoryIds?.includes(ch.categoryId)) continue;
        if (indexCfg.excludedChannelIds?.includes(ch.id)) continue;
        if (indexCfg.excludedNameKeywords?.some(kw => ch.name.toLowerCase().includes(kw))) continue;
        const key = ch.category || 'No Category';
        if (!byCategory[key]) byCategory[key] = [];
        byCategory[key].push(ch);
      }
      const MAX_FIELDS = 25, MAX_CHARS = 5500;
      const embeds = []; let current = null; let fc = 0; let cc = 0; let first = true;
      const newEmbed = () => { const e = new EmbedBuilder().setColor(0x8a2be2); if (first) { e.setTitle('Channel Index').setTimestamp(); first = false; } return e; };
      current = newEmbed();
      for (const [cat, chs] of Object.entries(byCategory)) {
        const lines = chs.map(ch => { const d = descriptions[ch.id]?.description?.trim(); return `[${d?`**#${ch.name}** — ${d}`:`**#${ch.name}**`}](${ch.link})`; });
        const value = lines.join('\n').slice(0,1024) || '—';
        if (fc >= MAX_FIELDS || cc + cat.length + value.length > MAX_CHARS) { embeds.push(current); current = newEmbed(); fc = 0; cc = 0; }
        current.addFields({ name: cat, value }); fc++; cc += cat.length + value.length;
      }
      embeds.push(current);
      for (const e of embeds) await targetCh.send({ embeds: [e] });
      res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('✅ Channel index posted to #'+targetCh.name)}`);
    } catch (err) {
      res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('❌ Error: '+err.message)}`);
    }
  });

  // ── speed match ───────────────────────────────────────────────────────
  app.get('/speed-match', (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const cfg = ensureVcShuffleGuildConfig(guildId);
    const guild = client.guilds.cache.get(guildId);
    const state = shuffleState.get(guildId);
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const running = cfg.enabled;
    const nextAt = state?.nextShuffleAt ? new Date(state.nextShuffleAt).toLocaleTimeString() : '—';
    const textChannels  = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).sort((a,b)=>a.name.localeCompare(b.name)) : [];
    const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildVoice||c.type===ChannelType.GuildStageVoice).sort((a,b)=>a.name.localeCompare(b.name)) : [];
    const categories    = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildCategory).sort((a,b)=>a.rawPosition-b.rawPosition) : [];
    const statCard = (icon,label,val) => `<div class="card" style="text-align:center;padding:1rem;"><div style="font-size:1.75rem;margin-bottom:.2rem;">${icon}</div><div style="font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);">${label}</div><div style="font-size:1rem;font-weight:600;margin-top:.2rem;">${val}</div></div>`;
    const body = `
      <div class="page-title">SPEED MATCH</div>
      <div class="page-sub">HIGH-SPEED CONNECTION — speed matching event management.</div>
      ${flash}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1rem;margin-bottom:1.5rem;">
        ${statCard(running?'🟢':'🔴','Status',running?'Running':'Idle')}
        ${statCard('🔄','Round','#'+(state?.roundNumber??0))}
        ${statCard('🤝','Pairs Made',state?.pairHistory?.size??0)}
        ${statCard('⏱','Next Bell',running?nextAt:'—')}
      </div>
      <div class="card"><div class="card-title">Session Controls</div>
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">Interval: <strong>${cfg.minIntervalMinutes}–${cfg.maxIntervalMinutes} min</strong></p>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap;">
          <form method="POST" action="/speed-match/start?guild=${guildId}"><button type="submit" class="btn btn-primary" ${running?'disabled':''}>▶️ Start Session</button></form>
          <form method="POST" action="/speed-match/bell?guild=${guildId}"><button type="submit" class="btn btn-ghost" ${!running?'disabled':''}>🔔 Ring Bell Now</button></form>
          <form method="POST" action="/speed-match/stop?guild=${guildId}"><button type="submit" class="btn btn-danger" ${!running?'disabled':''}>⏹ End Session</button></form>
        </div>
      </div>
      <form method="POST" action="/speed-match/config?guild=${guildId}">
        <div class="card"><div class="card-title">Configuration</div>
          <div class="form-row"><label>Lobby voice channel</label>
            <select name="lobbyChannelId"><option value="">— select lobby —</option>${voiceChannels.map(c=>`<option value="${c.id}" ${cfg.lobbyChannelIds?.includes(c.id)?'selected':''}>🔊 ${c.name}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Event category (temp rooms created here)</label>
            <select name="eventCategoryId"><option value="">— select category —</option>${categories.map(c=>`<option value="${c.id}" ${cfg.eventCategoryId===c.id?'selected':''}>📁 ${c.name}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Matchups / announcements channel</label>
            <select name="matchupsChannelId"><option value="">— select channel —</option>${textChannels.map(c=>`<option value="${c.id}" ${cfg.matchupsChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Staff panel channel</label>
            <select name="staffPanelChannelId"><option value="">— select channel —</option>${textChannels.map(c=>`<option value="${c.id}" ${cfg.staffPanelChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Min round interval (minutes)</label><input type="number" name="minIntervalMinutes" value="${cfg.minIntervalMinutes??3}" min="1" max="60"></div>
          <div class="form-row"><label>Max round interval (minutes)</label><input type="number" name="maxIntervalMinutes" value="${cfg.maxIntervalMinutes??3}" min="1" max="60"></div>
          <button type="submit" class="btn btn-primary">💾 Save Configuration</button>
        </div>
      </form>`;
    res.send(renderLayout({ title:'Speed Match', guildId, currentPath:'/speed-match', allowedGuildIds, username:req.session.userTag, body }));
  });

  app.post('/speed-match/start', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const cfg = ensureVcShuffleGuildConfig(guildId);
    if (!cfg.lobbyChannelIds?.length) return res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ Add a lobby channel first.')}`);
    try { await startVcShuffle(client.guilds.cache.get(guildId), guildId, true); res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Session started!')}`); }
    catch (err) { res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ '+err.message)}`); }
  });
  app.post('/speed-match/bell', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const guild = client.guilds.cache.get(guildId);
    try {
      const state = shuffleState.get(guildId);
      if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
      await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); scheduleNextShuffle(guild, guildId); await refreshStaffPanel(guild, guildId);
      res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('🔔 Bell rung!')}`);
    } catch (err) { res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ '+err.message)}`); }
  });
  app.post('/speed-match/stop', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    try { await stopVcShuffle(client.guilds.cache.get(guildId), guildId); res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('⏹ Session ended.')}`); }
    catch (err) { res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ '+err.message)}`); }
  });
  app.post('/speed-match/config', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const cfg = ensureVcShuffleGuildConfig(guildId);
    if (req.body.lobbyChannelId && !cfg.lobbyChannelIds.includes(req.body.lobbyChannelId)) cfg.lobbyChannelIds.push(req.body.lobbyChannelId);
    if (req.body.eventCategoryId !== undefined) cfg.eventCategoryId = req.body.eventCategoryId || null;
    if (req.body.matchupsChannelId !== undefined) cfg.matchupsChannelId = req.body.matchupsChannelId || null;
    if (req.body.staffPanelChannelId !== undefined) { cfg.staffPanelChannelId = req.body.staffPanelChannelId || null; cfg.staffPanelMessageId = null; }
    const min = parseInt(req.body.minIntervalMinutes); const max = parseInt(req.body.maxIntervalMinutes);
    if (!isNaN(min) && min>=1) cfg.minIntervalMinutes = min;
    if (!isNaN(max) && max>=1) cfg.maxIntervalMinutes = max;
    await saveVcShuffleConfig(vcShuffleConfig);
    res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Configuration saved.')}`);
  });

  // ── sticky posts ──────────────────────────────────────────────────────
  app.get('/sticky', async (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const guild = client.guilds.cache.get(guildId);
    const gSticky = stickyCache[guildId] || {};
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const channels = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).sort((a,b)=>a.name.localeCompare(b.name)) : [];
    const existingRows = Object.entries(gSticky).map(([chId, entry]) => {
      const ch = guild?.channels.cache.get(chId);
      return `<tr>
        <td style="white-space:nowrap">#${ch?.name||chId}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.85rem;">${entry.content.replace(/</g,'&lt;')}</td>
        <td><form method="POST" action="/sticky/delete?guild=${guildId}" style="display:inline"><input type="hidden" name="channelId" value="${chId}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">🗑 Remove</button></form></td>
      </tr>`;
    }).join('');
    const body = `
      <div class="page-title">STICKY POSTS</div>
      <div class="page-sub">Messages that re-post at the bottom of a channel.</div>
      ${flash}
      <div class="card"><div class="card-title">Add Sticky Post</div>
        <form method="POST" action="/sticky/save?guild=${guildId}">
          <div class="form-row"><label>Channel</label>
            <select name="channelId"><option value="">— select channel —</option>
              ${channels.map(c=>`<option value="${c.id}">#${c.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-row"><label>Message</label><textarea name="content" placeholder="Your sticky message..." rows="3"></textarea></div>
          <button type="submit" class="btn btn-primary">📌 Set Sticky</button>
        </form>
      </div>
      ${existingRows ? `<div class="card"><div class="card-title">Active Sticky Posts</div><table><thead><tr><th>Channel</th><th>Message</th><th>Actions</th></tr></thead><tbody>${existingRows}</tbody></table></div>` : ''}`;
    res.send(renderLayout({ title:'Sticky Posts', guildId, currentPath:'/sticky', allowedGuildIds, username:req.session.userTag, body }));
  });

  app.post('/sticky/save', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const { channelId, content } = req.body;
    if (!channelId || !content?.trim()) return res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('❌ Channel and message are required.')}`);
    if (!stickyCache[guildId]) stickyCache[guildId] = {};
    stickyCache[guildId][channelId] = { content: content.trim() };
    await saveSticky(stickyCache);
    res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post saved.')}`);
  });
  app.post('/sticky/delete', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    if (stickyCache[guildId]) delete stickyCache[guildId][req.body.channelId];
    await saveSticky(stickyCache);
    res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post removed.')}`);
  });

  // ── auto responders ───────────────────────────────────────────────────
  app.get('/autoresponder', async (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const gAR = arCache[guildId] || [];
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const rows = gAR.map((rule, i) => `<tr>
      <td><code style="color:var(--magenta)">${rule.trigger.replace(/</g,'&lt;')}</code></td>
      <td><span style="font-size:.74rem;background:var(--surface2);padding:.12rem .4rem;border-radius:3px;">${rule.matchType}</span></td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.85rem;">${rule.response.replace(/</g,'&lt;')}</td>
      <td><form method="POST" action="/autoresponder/delete?guild=${guildId}" style="display:inline"><input type="hidden" name="index" value="${i}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">🗑 Remove</button></form></td>
    </tr>`).join('');
    const body = `
      <div class="page-title">AUTO RESPONDERS</div>
      <div class="page-sub">Bot replies automatically when a trigger word or phrase is detected.</div>
      ${flash}
      <div class="card"><div class="card-title">Add Auto Responder</div>
        <form method="POST" action="/autoresponder/save?guild=${guildId}">
          <div class="form-row"><label>Trigger phrase</label><input type="text" name="trigger" placeholder="e.g. !rules"></div>
          <div class="form-row"><label>Match type</label>
            <select name="matchType"><option value="contains">Contains</option><option value="exact">Exact match</option></select>
          </div>
          <div class="form-row"><label>Response</label><textarea name="response" rows="3" placeholder="Bot's reply..."></textarea></div>
          <button type="submit" class="btn btn-primary">➕ Add Responder</button>
        </form>
      </div>
      ${rows ? `<div class="card"><div class="card-title">Active Responders (${gAR.length})</div><table><thead><tr><th>Trigger</th><th>Match</th><th>Response</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
    res.send(renderLayout({ title:'Auto Responders', guildId, currentPath:'/autoresponder', allowedGuildIds, username:req.session.userTag, body }));
  });

  app.post('/autoresponder/save', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const { trigger, matchType, response } = req.body;
    if (!trigger?.trim() || !response?.trim()) return res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('❌ Trigger and response are required.')}`);
    if (!arCache[guildId]) arCache[guildId] = [];
    arCache[guildId].push({ trigger: trigger.trim(), matchType: matchType||'contains', response: response.trim() });
    await saveAR(arCache);
    res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder added.')}`);
  });
  app.post('/autoresponder/delete', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const idx = parseInt(req.body.index);
    if (arCache[guildId]) arCache[guildId].splice(idx, 1);
    await saveAR(arCache);
    res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder removed.')}`);
  });

  // ── temp roles ────────────────────────────────────────────────────────
  app.get('/temproles', async (req, res) => {
    const guildId = resolveGuildId(req);
    const allowedGuildIds = req.session.allowedGuildIds || [];
    if (!guildId) return res.redirect('/');
    const guild = client.guilds.cache.get(guildId);
    const cfg = tempRolesCache[guildId] || {};
    const roles = guild ? [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a,b) => b.position - a.position) : [];
    const textChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).sort((a,b) => a.name.localeCompare(b.name)) : [];
    const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌') ? 'flash-err' : 'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
    const monitoredIds = cfg.monitoredChannelIds || [];
    const tagRoleIds   = cfg.tagRoleIds || [];
    const roleOpts  = (sel) => roles.map(r => `<option value="${r.id}" ${r.id===sel?'selected':''}>${r.name}</option>`).join('');
    const chanOpts  = (sel) => textChannels.map(c => `<option value="${c.id}" ${c.id===sel?'selected':''}>#${c.name}</option>`).join('');
    const timedRows = (cfg.timedRoles || []).map((r, i) => {
      const role = guild?.roles.cache.get(r.roleId);
      return `<tr>
        <td><span style="color:var(--magenta)">@${role?.name || r.roleId}</span></td>
        <td>${r.durationMinutes} min</td>
        <td>
          <form method="POST" action="/temproles/timed/postbutton?guild=${guildId}" style="display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;">
            <input type="hidden" name="roleId" value="${r.roleId}">
            <input type="hidden" name="durationMinutes" value="${r.durationMinutes}">
            <select name="channelId" style="flex:1;min-width:110px;padding:.2rem .4rem;font-size:.78rem;">
              <option value="">— channel —</option>${chanOpts('')}
            </select>
            <input type="text" name="label" value="Get Role" style="width:80px;padding:.2rem .4rem;font-size:.78rem;">
            <button type="submit" class="btn btn-ghost" style="padding:.2rem .5rem;font-size:.75rem;">📤 Post</button>
          </form>
        </td>
        <td><form method="POST" action="/temproles/timed/delete?guild=${guildId}"><input type="hidden" name="index" value="${i}"><button type="submit" class="btn btn-danger" style="padding:.2rem .5rem;font-size:.75rem;">🗑</button></form></td>
      </tr>`;
    }).join('');
    const body = `
      <div class="page-title">TEMP ROLES</div>
      <div class="page-sub">VC presence roles and timed button roles.</div>
      ${flash}
      <form method="POST" action="/temproles/vc/save?guild=${guildId}">
        <div class="card"><div class="card-title">VC Role — Applied on Join, Removed on Leave</div>
          <div class="form-row"><label>Role to apply on VC join</label>
            <select name="vcRoleId"><option value="">— none —</option>${roleOpts(cfg.vcRoleId)}</select>
          </div>
          <div class="form-row"><label>Monitored voice channels (blank = all VCs)</label>
            <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">
              ${voiceChannels.map(c => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;">
                <input type="checkbox" name="monitoredChannelIds" value="${c.id}" ${monitoredIds.includes(c.id) ? 'checked' : ''}> 🔊 ${c.name}
              </label>`).join('')}
            </div>
          </div>
          <div class="form-row"><label>Roles to @tag in join message</label>
            <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">
              ${roles.map(r => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;">
                <input type="checkbox" name="tagRoleIds" value="${r.id}" ${tagRoleIds.includes(r.id) ? 'checked' : ''}> @${r.name}
              </label>`).join('')}
            </div>
          </div>
          <div class="form-row"><label>VC text channel</label>
            <select name="vcTextChannelId"><option value="">— none —</option>${chanOpts(cfg.vcTextChannelId)}</select>
          </div>
          <div class="form-row"><label>Announcement channel (0→1 person only)</label>
            <select name="announceChannelId"><option value="">— none —</option>${chanOpts(cfg.announceChannelId)}</select>
          </div>
          <div class="form-row"><label>Custom join message</label>
            <input type="text" name="announceMsg" value="${(cfg.announceMsg||'').replace(/"/g,'&quot;')}" placeholder="{user} joined {channel}! {roles}">
          </div>
          <button type="submit" class="btn btn-primary">💾 Save VC Role Config</button>
        </div>
      </form>
      <form method="POST" action="/temproles/timed/save?guild=${guildId}">
        <div class="card"><div class="card-title">Add Timed Button Role</div>
          <div class="form-row"><label>Role</label>
            <select name="roleId"><option value="">— select role —</option>${roleOpts('')}</select>
          </div>
          <div class="form-row"><label>Duration (minutes)</label><input type="number" name="durationMinutes" value="30" min="1" max="10080"></div>
          <button type="submit" class="btn btn-primary">➕ Add Timed Role</button>
        </div>
      </form>
      ${timedRows ? `<div class="card"><div class="card-title">Active Timed Roles</div><table><thead><tr><th>Role</th><th>Duration</th><th>Post button to…</th><th></th></tr></thead><tbody>${timedRows}</tbody></table></div>` : ''}`;
    res.send(renderLayout({ title: 'Temp Roles', guildId, currentPath: '/temproles', allowedGuildIds, username: req.session.userTag, body }));
  });

  app.post('/temproles/vc/save', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    if (!tempRolesCache[guildId]) tempRolesCache[guildId] = {};
    const mc = req.body.monitoredChannelIds; const tr2 = req.body.tagRoleIds;
    tempRolesCache[guildId].vcRoleId            = req.body.vcRoleId || null;
    tempRolesCache[guildId].vcTextChannelId     = req.body.vcTextChannelId || null;
    tempRolesCache[guildId].announceChannelId   = req.body.announceChannelId || null;
    tempRolesCache[guildId].announceMsg         = req.body.announceMsg?.trim() || null;
    tempRolesCache[guildId].monitoredChannelIds = mc ? (Array.isArray(mc) ? mc : [mc]) : [];
    tempRolesCache[guildId].tagRoleIds          = tr2 ? (Array.isArray(tr2) ? tr2 : [tr2]) : [];
    await saveTR(tempRolesCache);
    res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ VC role config saved.')}`);
  });
  app.post('/temproles/timed/save', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const { roleId, durationMinutes } = req.body;
    if (!roleId) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Select a role.')}`);
    if (!tempRolesCache[guildId]) tempRolesCache[guildId] = {};
    if (!tempRolesCache[guildId].timedRoles) tempRolesCache[guildId].timedRoles = [];
    tempRolesCache[guildId].timedRoles.push({ roleId, durationMinutes: parseInt(durationMinutes) || 30 });
    await saveTR(tempRolesCache);
    res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Timed role added.')}`);
  });
  app.post('/temproles/timed/postbutton', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const { roleId, channelId, label, durationMinutes } = req.body;
    if (!channelId) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Select a channel to post to.')}`);
    const guild = client.guilds.cache.get(guildId);
    const ch = guild?.channels.cache.get(channelId);
    if (!ch) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Channel not found.')}`);
    try {
      const role = guild.roles.cache.get(roleId);
      const btn = new ButtonBuilder().setCustomId(`temprole:${roleId}`).setLabel(label?.trim() || 'Get Role').setStyle(ButtonStyle.Primary);
      await ch.send({ content: `Click the button below to receive the **${role?.name || 'role'}** for ${durationMinutes} minute(s).`, components: [new ActionRowBuilder().addComponents(btn)] });
      res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Button posted to #' + ch.name)}`);
    } catch (err) { res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Error: ' + err.message)}`); }
  });
  app.post('/temproles/timed/delete', async (req, res) => {
    const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
    const idx = parseInt(req.body.index);
    if (tempRolesCache[guildId]?.timedRoles) tempRolesCache[guildId].timedRoles.splice(idx, 1);
    await saveTR(tempRolesCache);
    res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Timed role removed.')}`);
  });

  // ── tos / privacy ─────────────────────────────────────────────────────
  app.get('/tos', (req, res) => {
    const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
    const body = `<div class="page-title">TERMS OF SERVICE</div><div class="card"><p style="color:var(--muted);font-size:.9rem;line-height:1.8">HIGH-SPEED CONNECTION BOT may be used only in accordance with Discord's Terms of Service. Session data is stored in memory only and discarded when the session ends. No audio or video is recorded. The bot software is owned by HIGH-SPEED CONNECTION BOT. You may not copy, redistribute, sell, sublicense, or commercially exploit it without authorization.</p></div>`;
    res.send(renderLayout({ title: 'Terms of Service', guildId, currentPath: '/tos', allowedGuildIds, username: req.session.userTag, body }));
  });
  app.get('/privacy', (req, res) => {
    const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
    const body = `<div class="page-title">PRIVACY POLICY</div><div class="card"><p style="color:var(--muted);font-size:.9rem;line-height:1.8">We collect your Discord username and guild membership via OAuth2 solely to authenticate you and show the servers you manage. During an active event, pair/skip history is stored in memory only and discarded when the session ends. Dashboard login info is stored in an in-memory session and expires after 7 days or on server restart. We do not sell or share your data with third parties.</p></div>`;
    res.send(renderLayout({ title: 'Privacy Policy', guildId, currentPath: '/privacy', allowedGuildIds, username: req.session.userTag, body }));
  });

  app.listen(PORT, () => { console.log(`[dashboard] Listening on port ${PORT}`); });
}

main().catch(err => { console.error('[startup] Fatal error:', err); process.exit(1); });
