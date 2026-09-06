// HIGH-SPEED CONNECTION — Discord community management bot
// - Channel indexer + camera policy + High-Speed Connection VC events
// - OAuth2 dashboard (Discord login) — users see only their own guilds
// - Activity tracker REMOVED in this version

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '.';
function dataPath(f) { return path.join(DATA_DIR, f); }

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[startup] Data directory ready: ${path.resolve(DATA_DIR)}`);
} catch (err) {
  console.error(`[startup] Could not create DATA_DIR (${DATA_DIR}):`, err.message);
}

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const TOKEN   = process.env.DISCORD_TOKEN;
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
//  CAMERA POLICY CONFIG
// ===========================================================================
const CAMERA_CONFIG_FILE     = dataPath('camera-config.json');
const DEFAULT_GRACE_MINUTES   = 2;
const DEFAULT_WARNING_MINUTES = 3;

function loadCameraConfig() {
  try { return JSON.parse(fs.readFileSync(CAMERA_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveCameraConfig(config) {
  try {
    fs.writeFileSync(CAMERA_CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[camera] Config saved to ${CAMERA_CONFIG_FILE}`);
    return true;
  } catch (err) {
    console.error(`[camera] FAILED to save config:`, err.message);
    return false;
  }
}

let cameraConfig = loadCameraConfig();
for (const [gid, cfg] of Object.entries(cameraConfig)) {
  console.log(`[startup] camera-config guild=${gid} enabled=${cfg.enabled} monitoredChannels=${cfg.monitoredChannels?.length ?? 0}`);
}
if (Object.keys(cameraConfig).length === 0) {
  console.warn(`[startup] camera-config.json is empty — is DATA_DIR=${DATA_DIR} correct and volume mounted?`);
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
function setCameraPolicyEnabled(guildId, en) { ensureGuildConfig(guildId).enabled = en; return saveCameraConfig(cameraConfig); }
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
const CHANNEL_INDEX_CONFIG_FILE = dataPath('channel-index-config.json');
const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildMedia]: 'media',
};

function loadChannelIndexConfig() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_INDEX_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveChannelIndexConfig(c) {
  try { fs.writeFileSync(CHANNEL_INDEX_CONFIG_FILE, JSON.stringify(c, null, 2)); return true; }
  catch (err) { console.error('[channel-index] save fail:', err.message); return false; }
}
let channelIndexConfig = loadChannelIndexConfig();

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

const CHANNELS_FILE = dataPath('channels.json');
function exportToFile(guild) {
  const data = getChannelData(guild);
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
  return data;
}

const DESCRIPTIONS_FILE = dataPath('descriptions.json');
function loadAllDescriptions() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf-8')); }
  catch { return {}; }
  const isLegacyFlat = Object.values(raw).some(v => v && typeof v === 'object' && 'name' in v && 'description' in v);
  if (isLegacyFlat) {
    const migrated = { [GUILD_ID]: raw };
    try { fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(migrated, null, 2)); } catch {}
    return migrated;
  }
  return raw;
}
function saveAllDescriptions(all) {
  try { fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(all, null, 2)); return true; }
  catch (err) { console.error('[descriptions] save fail:', err.message); return false; }
}
function loadDescriptions(guildId) { return loadAllDescriptions()[guildId] || {}; }
function ensureDescriptionsFile(guild) {
  const all = loadAllDescriptions();
  if (all[guild.id]) return;
  const data = getChannelData(guild);
  const template = {};
  for (const ch of data) template[ch.id] = { name: ch.name, description: '' };
  all[guild.id] = template;
  saveAllDescriptions(all);
}
// ===========================================================================
//  VC SHUFFLE / HIGH-SPEED CONNECTION
// ===========================================================================
const VC_SHUFFLE_CONFIG_FILE = dataPath('speed-match-config.json');
function loadVcShuffleConfig() {
  try { return JSON.parse(fs.readFileSync(VC_SHUFFLE_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveVcShuffleConfig(d) {
  try { fs.writeFileSync(VC_SHUFFLE_CONFIG_FILE, JSON.stringify(d, null, 2)); return true; }
  catch (err) { console.error('[speed-match] save fail:', err.message); return false; }
}
let vcShuffleConfig = loadVcShuffleConfig();

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

function collectPoolMembers(guild, cfg) {
  const members = []; const seen = new Set();
  for (const chId of cfg.lobbyChannelIds) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      if (m.user.bot || seen.has(m.id)) continue;
      seen.add(m.id); members.push(m);
    }
  }
  return members;
}

async function cleanupShuffleChannels(guild, cfg) {
  const toDelete = [...cfg.createdChannelIds];
  cfg.createdChannelIds = []; saveVcShuffleConfig(vcShuffleConfig);
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
  if (!state.pairHistory)    state.pairHistory    = new Set();
  if (!state.skipHistory)    state.skipHistory    = new Set();
  if (!state.matchAgainVotes) state.matchAgainVotes = new Map();

  // Handle "Match Again" votes
  const confirmedRePairs = new Set(); const matchPairs = [];
  for (const [voterId, partnerId] of state.matchAgainVotes.entries()) {
    if (state.matchAgainVotes.get(partnerId) === voterId && !confirmedRePairs.has(voterId)) {
      confirmedRePairs.add(voterId); confirmedRePairs.add(partnerId);
      matchPairs.push([voterId, partnerId]);
    }
  }
  state.matchAgainVotes = new Map();
  console.log(`[speed-match] Guild ${guildId}: round #${round}, rePairs=${matchPairs.length}`);

  // Collect pool from lobby + cloud rooms
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

  // Assign participant role
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

  // Countdown on round 1
  if (round === 1 && matchupCh) {
    for (const num of ['5️⃣', '4️⃣', '3️⃣', '2️⃣', '1️⃣']) {
      const m = await matchupCh.send(num).catch(() => null);
      await new Promise(r => setTimeout(r, 1000));
      if (m) m.delete().catch(() => {});
    }
    const go = await matchupCh.send('💨 **GO!**').catch(() => null);
    if (go) setTimeout(() => go.delete().catch(() => {}), 3000);
  }

  // Move into cloud rooms
  const activeRoomIds = [];
  for (let i = 0; i < groups.length; i++) {
    let roomCh = cloudRoomIds[i] ? guild.channels.cache.get(cloudRoomIds[i]) : null;
    if (!roomCh) {
      try {
        roomCh = await guild.channels.create({ name: `speed-match-${i + 1}`, type: ChannelType.GuildVoice, parent: cfg.categoryId || null, reason: `💨 HSC round #${round} overflow` });
        if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
        cfg.cloudRoomIds.push(roomCh.id);
      } catch (err) { console.error(`[speed-match] create overflow room:`, err.message); continue; }
    }
    activeRoomIds.push(roomCh.id);
    for (const m of groups[i])
      await roomCh.permissionOverwrites.edit(m, { ViewChannel: true, Connect: true, Speak: true }).catch(() => {});
    for (const m of groups[i])
      await m.voice.setChannel(roomCh, `💨 HSC round #${round}`).catch(err => console.error(`[speed-match] move ${m.id}:`, err.message));
    await postRoomActionButtons(guild, guildId, roomCh, groups[i]);
  }

  // Move anyone in unused cloud rooms back to lobby
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  for (let i = groups.length; i < cloudRoomIds.length; i++) {
    const roomCh = guild.channels.cache.get(cloudRoomIds[i]);
    if (!roomCh) continue;
    for (const m of roomCh.members.values()) {
      if (m.user.bot) continue;
      if (lobby) await m.voice.setChannel(lobby, '💨 Moved to lobby — room unused').catch(() => {});
    }
  }
  cfg.createdChannelIds = activeRoomIds;
  saveVcShuffleConfig(vcShuffleConfig);

  // Post matchups embed
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

  // Schedule warning
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
    cfg.staffPanelMessageId = msg.id; saveVcShuffleConfig(vcShuffleConfig);
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
  const cfg = ensureVcShuffleGuildConfig(guildId); cfg.enabled = true; saveVcShuffleConfig(vcShuffleConfig);
  const existing = shuffleState.get(guildId);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  if (existing?.warningTimeoutId) clearTimeout(existing.warningTimeoutId);
  shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set(), skipHistory: new Set(), matchAgainVotes: new Map() });
  if (runImmediately) await runShuffleRound(guild, guildId);
  scheduleNextShuffle(guild, guildId);
}

async function stopVcShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  cfg.enabled = false; saveVcShuffleConfig(vcShuffleConfig);
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

  // Participant role auto-assign on lobby join
  if (nowIn && newState.member && !newState.member.user.bot) {
    const sc = vcShuffleConfig[guildId];
    if (sc?.enabled && sc.participantRoleId && sc.lobbyChannelIds?.includes(newState.channelId)) {
      try {
        if (!newState.member.roles.cache.has(sc.participantRoleId))
          await newState.member.roles.add(sc.participantRoleId, '💨 HSC: joined lobby');
      } catch (err) { console.error(`[speed-match] participant role assign fail:`, err.message); }
    }
  }

  // Camera policy
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

    // ── Main menu ──────────────────────────────────────────────────────────
    if (id === 'setup:main') return interaction.update(buildMainMenuMessage());
    if (id === 'setup:main:select') {
      const v = interaction.values[0];
      if (v === 'camera')     return interaction.update(buildCameraMenuMessage(guildId));
      if (v === 'speedmatch') return interaction.update(buildSpeedMatchSetupMessage(guildId));
      if (v === 'temproles')  return interaction.update(buildTempRolesSetupMessage(guildId));
      if (v === 'sticky' || v === 'autorespond') return interaction.update(buildStickyARSetupMessage(guildId, v));
      return;
    }

    // ── Camera ─────────────────────────────────────────────────────────────
    if (id === 'setup:camera:menu')            return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:camera:categories-menu') return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    if (id === 'setup:camera:toggle') {
      const cfg = ensureGuildConfig(guildId); cfg.enabled = !cfg.enabled;
      const saved = saveCameraConfig(cameraConfig);
      if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
      await interaction.update(buildCameraMenuMessage(guildId));
      if (!saved) await interaction.followUp({ content: '⚠️ Save failed.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === 'setup:camera:channels:select') { ensureGuildConfig(guildId).monitoredChannels = interaction.values; saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
    if (id === 'setup:camera:announcechannel:select') { ensureGuildConfig(guildId).announcementChannelId = interaction.values[0] || null; saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
    if (id === 'setup:camera:categories:select') { ensureGuildConfig(guildId).monitoredCategoryIds = interaction.values; saveCameraConfig(cameraConfig); return interaction.update(buildCameraCategoriesMenuMessage(guildId)); }
    if (id === 'setup:camera:exempt:select') { ensureGuildConfig(guildId).exemptRoles = interaction.values; saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId)); }
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
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:announcement:modal') {
      ensureGuildConfig(guildId).announcementUrl = interaction.fields.getTextInputValue('url')?.trim() || null;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }

    // ── Speed Match ────────────────────────────────────────────────────────
    if (id === 'setup:sm:menu') return interaction.update(buildSpeedMatchSetupMessage(guildId));
    if (id === 'setup:sm:lobby:select') { ensureVcShuffleGuildConfig(guildId).lobbyChannelIds = interaction.values; saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:matchups:select') { ensureVcShuffleGuildConfig(guildId).matchupsChannelId = interaction.values[0] || null; saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:staffpanel:select') { const c = ensureVcShuffleGuildConfig(guildId); c.staffPanelChannelId = interaction.values[0] || null; c.staffPanelMessageId = null; saveVcShuffleConfig(vcShuffleConfig); return interaction.update(buildSpeedMatchSetupMessage(guildId)); }
    if (id === 'setup:sm:setinterval') {
      const cfg = ensureVcShuffleGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:sm:interval:modal').setTitle('Speed Match — Round Interval');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min').setLabel('Min minutes per round').setStyle(TextInputStyle.Short).setValue(String(cfg.minIntervalMinutes ?? 3)).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('max').setLabel('Max minutes per round').setStyle(TextInputStyle.Short).setValue(String(cfg.maxIntervalMinutes ?? 3)).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (id === 'setup:sm:interval:modal') {
      const min = parseInt(interaction.fields.getTextInputValue('min'), 10); const max = parseInt(interaction.fields.getTextInputValue('max'), 10);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return interaction.reply({ content: '❌ Min must be 1+ and max ≥ min.', flags: MessageFlags.Ephemeral });
      const cfg = ensureVcShuffleGuildConfig(guildId); cfg.minIntervalMinutes = min; cfg.maxIntervalMinutes = max; saveVcShuffleConfig(vcShuffleConfig);
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

    // ── Temp Roles ─────────────────────────────────────────────────────────
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
      const tr = loadTR(); if (!tr[guildId]) tr[guildId] = {};
      const roleId = interaction.fields.getTextInputValue('roleId')?.trim() || null;
      const ac = interaction.fields.getTextInputValue('announceChannelId')?.trim() || null;
      const vt = interaction.fields.getTextInputValue('vcTextChannelId')?.trim() || null;
      const am = interaction.fields.getTextInputValue('announceMsg')?.trim() || null;
      if (roleId) tr[guildId].vcRoleId = roleId;
      if (ac) tr[guildId].announceChannelId = ac;
      if (vt) tr[guildId].vcTextChannelId = vt;
      if (am) tr[guildId].announceMsg = am;
      saveTR(tr); return interaction.update(buildTempRolesSetupMessage(guildId));
    }
    if (id === 'setup:tr:addtimed') {
      const modal = new ModalBuilder().setCustomId('setup:tr:addtimed:modal').setTitle('Add Timed Role');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roleId').setLabel('Role ID').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (minutes)').setStyle(TextInputStyle.Short).setRequired(true).setValue('30')));
      return interaction.showModal(modal);
    }
    if (id === 'setup:tr:addtimed:modal') {
      const tr = loadTR(); if (!tr[guildId]) tr[guildId] = {}; if (!tr[guildId].timedRoles) tr[guildId].timedRoles = [];
      const roleId = interaction.fields.getTextInputValue('roleId')?.trim();
      if (!roleId) return interaction.reply({ content: '❌ Role ID required.', flags: MessageFlags.Ephemeral });
      tr[guildId].timedRoles.push({ roleId, durationMinutes: parseInt(interaction.fields.getTextInputValue('duration')) || 30 });
      saveTR(tr); return interaction.update(buildTempRolesSetupMessage(guildId));
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

    // ── Sticky ─────────────────────────────────────────────────────────────
    if (id === 'setup:sticky:add') {
      const modal = new ModalBuilder().setCustomId('setup:sticky:add:modal').setTitle('Add Sticky Note');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channelId').setLabel('Channel ID').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Sticky message content').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (id === 'setup:sticky:add:modal') {
      const channelId = interaction.fields.getTextInputValue('channelId')?.trim();
      const content = interaction.fields.getTextInputValue('content')?.trim();
      if (!channelId || !content) return interaction.reply({ content: '❌ Channel ID and message required.', flags: MessageFlags.Ephemeral });
      const sticky = loadSticky(); if (!sticky[guildId]) sticky[guildId] = {};
      sticky[guildId][channelId] = { content }; saveSticky(sticky);
      return interaction.reply({ content: `✅ Sticky set for <#${channelId}>!`, flags: MessageFlags.Ephemeral });
    }

    // ── Auto Responder ─────────────────────────────────────────────────────
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
      const ar = loadAR(); if (!ar[guildId]) ar[guildId] = [];
      ar[guildId].push({ trigger, matchType, response }); saveAR(ar);
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

// Setup sub-menu builders
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
  const cfg = loadTR()[guildId] || {};
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
    .setDescription((isAR ? 'Auto responders reply when a trigger is detected in any message.' : 'Sticky notes re-post at the bottom of a channel whenever someone sends a message.') + '\n\n> Manage all entries from the Dashboard at **high-speed-connection.fly.dev**');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(isAR ? 'setup:ar:add' : 'setup:sticky:add').setLabel(isAR ? '➕ Add Auto Responder' : '➕ Add Sticky Note').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ===========================================================================
//  HSC BUTTON HANDLER (Match Again / Skip + Staff Panel)
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
    // /help
    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT — Commands')
        .addFields(
          { name: '📋 General',              value: '`/help` `/botinfo` `/serverinfo` `/userinfo` `/roleinfo` `/purge`', inline: false },
          { name: '# Channel Index',         value: '`/channel-index` `/export-channels`', inline: false },
          { name: '📷 Camera Policy',        value: '`/camera-policy` `/camera-status` `/camera-monitor` `/camera-exempt-role` `/camera-timing` `/camera-announcement`', inline: false },
          { name: '💨 High-Speed Connection',value: '`/speed-match start/stop/status/shuffle-now/end-session`\n`/speed-match set-connection-mode` `/speed-match set-holding-channel` and more', inline: false },
          { name: '⚙️ Admin',                value: '`/setup` — interactive config menu', inline: false },
          { name: '📖 Dashboard',            value: 'high-speed-connection.fly.dev - log in with Discord', inline: false },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Made with 🖤' });
      return interaction.reply({ embeds: [embed] });
    }

    // /botinfo
    if (interaction.commandName === 'botinfo') {
      const guilds = client.guilds.cache.size;
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600); const minutes = Math.floor((uptime % 3600) / 60);
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT')
        .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Bot Tag',         value: client.user.tag,                                       inline: true },
          { name: 'Servers',         value: String(guilds),                                         inline: true },
          { name: 'Uptime',          value: `${hours}h ${minutes}m`,                               inline: true },
          { name: 'Dashboard',       value: 'high-speed-connection.fly.dev',          inline: false },
          { name: 'Terms of Service',value: 'high-speed-connection.fly.dev/tos',      inline: true },
          { name: 'Privacy Policy',  value: 'high-speed-connection.fly.dev/privacy',  inline: true },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Discord Community Management' }).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // /serverinfo
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

    // /export-channels
    if (interaction.commandName === 'export-channels') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = exportToFile(interaction.guild);
      return interaction.editReply({ content: `Exported ${data.length} channels.`, files: [CHANNELS_FILE] });
    }

    // /userinfo
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
          { name: 'User ID',        value: fullUser.id,                                              inline: true },
          { name: 'Display Name',   value: fullUser.globalName || fullUser.username,                  inline: true },
          { name: 'Bot Account',    value: fullUser.bot ? 'Yes' : 'No',                             inline: true },
          { name: 'Account Created',value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:F>`, inline: false },
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

    // /roleinfo
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
          { name: 'Role ID',          value: role.id,                                              inline: true },
          { name: 'Color',            value: role.hexColor,                                         inline: true },
          { name: 'Position',         value: String(role.position),                                 inline: true },
          { name: 'Members',          value: String(memberCount),                                   inline: true },
          { name: 'Mentionable',      value: role.mentionable ? 'Yes' : 'No',                      inline: true },
          { name: 'Hoisted',          value: role.hoist ? 'Yes (shown separately)' : 'No',         inline: true },
          { name: 'Managed',          value: role.managed ? 'Yes (bot/integration)' : 'No',        inline: true },
          { name: 'Created',          value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`,  inline: true },
          { name: 'Key Permissions',  value: activePerms.length ? activePerms.join(', ') : 'None notable', inline: false },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // /purge — confirmation step
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

    // /camera-policy
    if (interaction.commandName === 'camera-policy') {
      const enabled = interaction.options.getString('state') === 'on';
      const saved   = setCameraPolicyEnabled(interaction.guildId, enabled);
      if (!enabled) {
        for (const [key, info] of warnedUsers.entries()) {
          if (!key.startsWith(`${interaction.guildId}:`)) continue;
          if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
          if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
          warnedUsers.delete(key);
        }
      }
      const saveWarning = saved ? '' : '\n⚠️ **Save failed** — check Fly.io logs for DATA_DIR write error.';
      return interaction.reply({ content: (enabled ? '📷 Camera policy is now **ON**.' : '📴 Camera policy is now **OFF**.') + saveWarning });
    }

    // /camera-status
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

    // /camera-monitor
    if (interaction.commandName === 'camera-monitor') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** is already monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels.push(ch.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Now monitoring **#${ch.name}** for the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const ch = interaction.options.getChannel('channel');
        if (!gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** wasn't monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels = gc.monitoredChannels.filter(id => id !== ch.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Stopped monitoring **#${ch.name}**.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Monitored voice channels:**\n${gc.monitoredChannels.length ? gc.monitoredChannels.map(id => `<#${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-exempt-role
    if (interaction.commandName === 'camera-exempt-role') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const role = interaction.options.getRole('role');
        if (gc.exemptRoles.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already exempt.`, flags: MessageFlags.Ephemeral });
        gc.exemptRoles.push(role.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is now exempt from the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const role = interaction.options.getRole('role');
        gc.exemptRoles = gc.exemptRoles.filter(id => id !== role.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is no longer exempt.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Exempt roles:**\n${gc.exemptRoles.length ? gc.exemptRoles.map(id => `<@&${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-timing
    if (interaction.commandName === 'camera-timing') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') {
        gc.graceMinutes   = interaction.options.getInteger('grace_minutes');
        gc.warningMinutes = interaction.options.getInteger('warning_minutes');
        saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Timing updated: **${gc.graceMinutes}m** grace + **${gc.warningMinutes}m** warning = **${gc.graceMinutes + gc.warningMinutes}m** total before removal.`);
      }
      if (sub === 'view') {
        const { graceMinutes, warningMinutes } = getTiming(interaction.guildId);
        return interaction.reply({ content: `**Grace:** ${graceMinutes}m\n**Warning:** ${warningMinutes}m\n**Total:** ${graceMinutes + warningMinutes}m`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-announcement
    if (interaction.commandName === 'camera-announcement') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') { gc.announcementUrl = interaction.options.getString('url'); saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link set.'); }
      if (sub === 'clear') { gc.announcementUrl = null; saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link cleared.'); }
      if (sub === 'view') { return interaction.reply({ content: gc.announcementUrl ? `Current link:\n${gc.announcementUrl}` : 'No link set.', flags: MessageFlags.Ephemeral }); }
    }

    // /channel-index
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

    // /speed-match
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
        cfg.minGroupSize = min; cfg.maxGroupSize = max; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Group size set to **${min}–${max}** per room.`);
      }
      if (sub === 'set-interval') {
        const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
        if (min > max) return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
        cfg.minIntervalMinutes = min; cfg.maxIntervalMinutes = max; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Interval set to **${min}–${max}** minutes.`);
      }
      if (sub === 'add-lobby') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (cfg.lobbyChannelIds.includes(ch.id)) return interaction.reply({ content: `**${ch.name}** is already a lobby.`, flags: MessageFlags.Ephemeral });
        cfg.lobbyChannelIds.push(ch.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** added as a lobby channel.`);
      }
      if (sub === 'remove-lobby') {
        const ch = interaction.options.getChannel('channel');
        cfg.lobbyChannelIds = cfg.lobbyChannelIds.filter(id => id !== ch.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** removed from lobby channels.`);
      }
      if (sub === 'set-category') {
        const ch = interaction.options.getChannel('category');
        if (ch.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ Must be a category.', flags: MessageFlags.Ephemeral });
        cfg.categoryId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Temp rooms will be created inside **${ch.name}**.`);
      }
      if (sub === 'set-announce') {
        const ch = interaction.options.getChannel('channel');
        cfg.announcementChannelId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Announcements will post in <#${ch.id}>.`);
      }
      if (sub === 'set-participant-role') {
        cfg.participantRoleId = interaction.options.getRole('role').id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${interaction.options.getRole('role').name}** set as participant role.`);
      }
      if (sub === 'add-staff-role') {
        const role = interaction.options.getRole('role');
        if (!cfg.staffRoleIds) cfg.staffRoleIds = [];
        if (cfg.staffRoleIds.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already a staff role.`, flags: MessageFlags.Ephemeral });
        cfg.staffRoleIds.push(role.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** added to staff roles.`);
      }
      if (sub === 'remove-staff-role') {
        const role = interaction.options.getRole('role');
        cfg.staffRoleIds = (cfg.staffRoleIds || []).filter(id => id !== role.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** removed from staff roles.`);
      }
      if (sub === 'set-bot-role') {
        cfg.botRoleId = interaction.options.getRole('role').id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Bot role set to **${interaction.options.getRole('role').name}**.`);
      }
      if (sub === 'set-warning-seconds') {
        cfg.warningSeconds = interaction.options.getInteger('seconds'); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Warning fires **${cfg.warningSeconds}s** before the bell.`);
      }
      if (sub === 'set-connection-mode') {
        const mode = interaction.options.getString('mode');
        cfg.connectionMode = mode; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Connection mode set to **${mode === 'role-based' ? 'Role-Based' : 'Standard'}**. ${mode === 'role-based' ? 'Configure pairing pools in the dashboard.' : ''}`);
      }
      if (sub === 'set-holding-channel') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        cfg.holdingChannelId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Holding channel set to **${ch.name}**. Skipped members will wait here until the bell.`);
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
//  STARTUP
// ===========================================================================
client.once('clientReady', async () => {
  console.log(`[startup] Logged in as ${client.user.tag}`);
  await registerCommands();
  const guild = await client.guilds.fetch(GUILD_ID);
  exportToFile(guild);
  ensureDescriptionsFile(guild);
});

client.on('error', err => console.error('[discord] client error:', err));
process.on('unhandledRejection', err => console.error('[process] unhandledRejection:', err));
// ===========================================================================


// ===========================================================================
//  WEB DASHBOARD — OAuth2 + Express
// ===========================================================================
const express   = require('express');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);

const PORT             = process.env.PORT || 3000;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET         = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const REDIRECT_URI           = process.env.DISCORD_REDIRECT_URI || 'https://high-speed-connection.fly.dev/auth/callback';
const DASHBOARD_URL          = process.env.DASHBOARD_URL || 'https://high-speed-connection.fly.dev';

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)
  console.warn('[dashboard] DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET not set — OAuth login will fail.');
if (!process.env.SESSION_SECRET)
  console.warn('[dashboard] SESSION_SECRET not set — sessions reset on every restart.');

const isProduction = !!process.env.FLY_APP_NAME || process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.json({ limit: '3mb' }));
app.use(session({
  store: new FileStore({ path: dataPath('sessions'), ttl: 7 * 24 * 60 * 60, retries: 1, logFn: () => {} }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── helpers ────────────────────────────────────────────────────────────────
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

// ── shared CSS ─────────────────────────────────────────────────────────────
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
    .tag-list{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem;}
    .tag{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:.2rem .6rem;font-size:.8rem;display:flex;align-items:center;gap:.4rem;}
    .tag button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.9rem;line-height:1;padding:0;}
    .tag button:hover{color:#ff6464;}
    table{width:100%;border-collapse:collapse;font-size:.85rem;}
    th{text-align:left;padding:.5rem .75rem;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);}
    td{padding:.6rem .75rem;border-bottom:1px solid rgba(255,0,255,.07);}
    tr:last-child td{border-bottom:none;}
    .guild-select{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem;}
    .guild-select select{max-width:280px;}
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
    ['/', 'Overview'],
    ['/camera', 'Camera Policy'],
    ['/channel-index', 'Channel Index'],
    ['/speed-match', 'Speed Match'],
    ['/sticky', 'Sticky Posts'],
    ['/autoresponder', 'Auto Responders'],
    ['/temproles', 'Temp Roles'],
  ];

  const sidebarLinks = navItems.map(([href, label]) =>
    `<a href="${href}${guildId ? '?guild='+guildId : ''}" ${currentPath === href ? 'class="active"' : ''}>${label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — HSC Dashboard</title>
<link rel="icon" type="image/gif" href="/images/highspeedpfp.gif">
${DASH_CSS}
</head><body>
<nav>
  <span class="nav-logo">⚙️ HSC DASHBOARD</span>
  <ul class="nav-links">
    <li><a href="https://high-speed-connection.fly.dev" target="_blank">← Site</a></li>
    <li class="nav-user">👤 ${username || 'Unknown'}</li>
    <li><a href="/logout">Log out</a></li>
  </ul>
</nav>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-section">Server</div>
    ${allowedGuildIds.length > 1 ? `<div style="padding:.5rem 1rem;"><select onchange="location.href=window.location.pathname+'?guild='+this.value">${guildOptions}</select></div>` : ''}
    <div class="sidebar-section">Pages</div>
    ${sidebarLinks}
    <div class="sidebar-section">Legal</div>
    <a href="/tos${guildId ? '?guild='+guildId : ''}">Terms of Service</a>
    <a href="/privacy${guildId ? '?guild='+guildId : ''}">Privacy Policy</a>
  </div>
  <div class="main">
    ${guildId && allowedGuildIds.length === 1 ? `<div style="font-size:.8rem;color:var(--muted);margin-bottom:1.5rem;">Server: <strong style="color:var(--text)">${client.guilds.cache.get(guildId)?.name || guildId}</strong></div>` : ''}
    ${body}
  </div>
</div>
</body></html>`;
}

// ── auth routes ────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) { console.error('[auth] session save error:', err); }
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI,
      response_type: 'code', scope: 'identify guilds', state,
    });
    const authUrl = `https://discord.com/oauth2/authorize?${params.toString()}`;
    res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Login — HSC Dashboard</title>
<link rel="icon" type="image/gif" href="/images/highspeedpfp.gif">
${DASH_CSS}
</head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;">
  <div style="text-align:center;max-width:400px;">
    <img src="/images/highspeedpfp.gif" style="width:80px;height:80px;border-radius:50%;border:2px solid rgba(255,0,255,.4);box-shadow:0 0 30px rgba(255,0,255,.3);margin-bottom:1.5rem;">
    <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;color:var(--magenta);text-shadow:0 0 20px var(--magenta-glow);letter-spacing:.08em;margin-bottom:.5rem;">HIGH-SPEED CONNECTION</div>
    <div style="color:var(--muted);font-size:.9rem;margin-bottom:2rem;">Log in with Discord to manage servers where you have Administrator access.</div>
    <a href="${authUrl}" class="btn btn-primary" style="font-size:1rem;padding:.75rem 2rem;">🔐 Log in with Discord</a>
  </div>
</div>
</body></html>`);
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) {
    console.warn('[auth] state mismatch or missing code', { state, sessionState: req.session.oauthState });
    return res.redirect('/login');
  }
  try {
    const tokenData = await exchangeCode(code);
    if (!tokenData.access_token) { console.error('[auth] no access token:', tokenData); return res.redirect('/login'); }
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

// ── overview ───────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.send(renderLayout({ title: 'Overview', guildId: null, currentPath: '/', allowedGuildIds, username: req.session.userTag,
    body: `<div class="card"><p>No servers found. Make sure the bot is installed in a server where you have Administrator.</p><p style="margin-top:1rem"><a href="/login">Switch account</a></p></div>` }));
  const guild = client.guilds.cache.get(guildId);
  const camCfg = loadCameraConfig()[guildId] || {};
  const vcCfg  = loadVcShuffleConfig()[guildId] || {};
  const body = `
    <div class="page-title">OVERVIEW</div>
    <div class="page-sub">Welcome back, ${req.session.userTag}</div>
    <div class="card">
      <div class="card-title">Server Stats</div>
      <table>
        <tr><td>Server</td><td><strong>${guild?.name || guildId}</strong></td></tr>
        <tr><td>Members</td><td>${guild?.memberCount ?? '—'}</td></tr>
        <tr><td>Camera Policy</td><td><span class="status-dot ${camCfg.enabled ? 'status-on' : 'status-off'}"></span>${camCfg.enabled ? 'Enabled' : 'Disabled'}</td></tr>
        <tr><td>Speed Match</td><td><span class="status-dot ${vcCfg.running ? 'status-on' : 'status-off'}"></span>${vcCfg.running ? 'Running' : 'Idle'}</td></tr>
      </table>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">
      ${[['Camera Policy','/camera'],['Channel Index','/channel-index'],['Speed Match','/speed-match'],['Sticky Posts','/sticky'],['Auto Responders','/autoresponder'],['Temp Roles','/temproles']]
        .map(([label, href]) => `<a href="${href}?guild=${guildId}" style="text-decoration:none;"><div class="card" style="text-align:center;padding:1.25rem;cursor:pointer;transition:border-color .2s;" onmouseover="this.style.borderColor='var(--magenta)'" onmouseout="this.style.borderColor=''"><div style="font-size:1.5rem;margin-bottom:.5rem">${{'/camera':'📷','/channel-index':'📋','/speed-match':'💨','/sticky':'📌','/autoresponder':'🤖','/temproles':'🎭'}[href]}</div><div style="font-size:.8rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)">${label}</div></div></a>`)
        .join('')}
    </div>`;
  res.send(renderLayout({ title: 'Overview', guildId, currentPath: '/', allowedGuildIds, username: req.session.userTag, body }));
});

// ── camera policy ─────────────────────────────────────────────────────────
// ── camera policy ─────────────────────────────────────────────────────────
app.get('/camera', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig()[guildId] || {};
  const guild = client.guilds.cache.get(guildId);
  const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const categories    = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildCategory).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const textChannels  = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const roles         = guild ? [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a,b) => b.position - a.position) : [];
  const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
  const monitored    = cfg.monitoredChannels || [];
  const monitoredCats = cfg.monitoredCategoryIds || [];
  const exempt       = cfg.exemptRoles || cfg.exemptRoleIds || [];

  const searchScript = `<script>
    function flist(inp,listId){const v=inp.value.toLowerCase();document.querySelectorAll('#'+listId+' label').forEach(l=>{l.style.display=l.textContent.toLowerCase().includes(v)?'':'none';});}
  </script>`;
  const optList = (id, items, checked, nameOf) => `
    <input type="text" placeholder="Search..." oninput="flist(this,'${id}')" style="margin-bottom:.4rem;">
    <div id="${id}" style="max-height:190px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">
      ${items.map(i => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;transition:background .15s;" onmouseover="this.style.background='var(--magenta-faint)'" onmouseout="this.style.background=''">
        <input type="checkbox" name="${id.split('-')[0]}" value="${i.id}" ${checked.includes(i.id)?'checked':''}> ${nameOf(i)}
      </label>`).join('')}
    </div>`;

  const body = `${searchScript}
    <div class="page-title">CAMERA POLICY</div>
    <div class="page-sub">Enforce camera-on rules in voice channels. Each section saves independently.</div>
    ${flash}

    <form method="POST" action="/camera/save/status?guild=${guildId}">
      <div class="card">
        <div class="card-title">Status</div>
        <div class="toggle"><input type="checkbox" id="enabled" name="enabled" ${cfg.enabled?'checked':''}><label for="enabled">Camera policy enabled</label></div>
        <div style="margin-top:1rem;"><button type="submit" class="btn btn-primary">💾 Save Status</button></div>
      </div>
    </form>

    <form method="POST" action="/camera/save/timing?guild=${guildId}">
      <div class="card">
        <div class="card-title">Timing</div>
        <div class="form-row"><label>Grace period (minutes) — silent, no message</label><input type="number" name="graceMinutes" value="${cfg.graceMinutes??2}" min="0" max="60"></div>
        <div class="form-row"><label>Warning period (minutes) — after reminder is sent</label><input type="number" name="warningMinutes" value="${cfg.warningMinutes??3}" min="1" max="60"></div>
        <button type="submit" class="btn btn-primary">💾 Save Timing</button>
      </div>
    </form>

    <form method="POST" action="/camera/save/announcement?guild=${guildId}">
      <div class="card">
        <div class="card-title">Announcement</div>
        <div class="form-row"><label>Announcement channel — where policy reminders are posted</label>
          <select name="announcementChannelId">
            <option value="">— no channel —</option>
            ${textChannels.map(c=>`<option value="${c.id}" ${cfg.announcementChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Announcement post URL — link to your camera policy post (optional)</label>
          <input type="text" name="announcementUrl" value="${cfg.announcementUrl||''}" placeholder="https://discord.com/channels/...">
        </div>
        <button type="submit" class="btn btn-primary">💾 Save Announcement</button>
      </div>
    </form>

    <form method="POST" action="/camera/save/channels?guild=${guildId}">
      <div class="card">
        <div class="card-title">Monitored Voice Channels &amp; Categories</div>
        <p style="font-size:.78rem;color:var(--muted);padding:.5rem .75rem;background:var(--magenta-faint);border-left:2px solid var(--magenta);border-radius:0 4px 4px 0;margin-bottom:1rem;">
          💡 You can select individual channels, entire categories, or both. Category selection monitors all voice channels inside it.
        </p>
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
      <div class="card">
        <div class="card-title">Exempt Roles</div>
        <p style="font-size:.78rem;color:var(--muted);margin-bottom:.75rem;">Members with these roles skip camera enforcement.</p>
        <div class="form-row">
          ${optList('exemptRoles-roles', roles, exempt, r => `@${r.name}`)}
        </div>
        <button type="submit" class="btn btn-primary">💾 Save Exempt Roles</button>
      </div>
    </form>`;
  res.send(renderLayout({ title:'Camera Policy', guildId, currentPath:'/camera', allowedGuildIds, username:req.session.userTag, body }));
});

app.post('/camera/save/status', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId].enabled = req.body.enabled === 'on';
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Status saved.')}`);
});
app.post('/camera/save/timing', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId].graceMinutes = parseInt(req.body.graceMinutes)||2;
  cfg[guildId].warningMinutes = parseInt(req.body.warningMinutes)||3;
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Timing saved.')}`);
});
app.post('/camera/save/announcement', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId].announcementChannelId = req.body.announcementChannelId || null;
  cfg[guildId].announcementUrl = req.body.announcementUrl?.trim() || null;
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Announcement saved.')}`);
});
app.post('/camera/save/channels', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  const mc = req.body['monitoredChannels-vc'] || req.body.monitoredChannels;
  const mcat = req.body['monitoredCategoryIds-cat'] || req.body.monitoredCategoryIds;
  cfg[guildId].monitoredChannels   = mc   ? (Array.isArray(mc)   ? mc   : [mc])   : [];
  cfg[guildId].monitoredCategoryIds = mcat ? (Array.isArray(mcat) ? mcat : [mcat]) : [];
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Monitored channels saved.')}`);
});
app.post('/camera/save/roles', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  const er = req.body['exemptRoles-roles'] || req.body.exemptRoles;
  cfg[guildId].exemptRoles   = er ? (Array.isArray(er) ? er : [er]) : [];
  cfg[guildId].exemptRoleIds = cfg[guildId].exemptRoles;
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Exempt roles saved.')}`);
});
app.post('/camera/save', (req, res) => { // legacy compat
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig(); if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId].enabled = req.body.enabled === 'on';
  cfg[guildId].graceMinutes = parseInt(req.body.graceMinutes)||2;
  cfg[guildId].warningMinutes = parseInt(req.body.warningMinutes)||3;
  const mc = req.body.monitoredChannels; cfg[guildId].monitoredChannels = mc?(Array.isArray(mc)?mc:[mc]):[];
  const er = req.body.exemptRoles; cfg[guildId].exemptRoles = er?(Array.isArray(er)?er:[er]):[];
  cfg[guildId].exemptRoleIds = cfg[guildId].exemptRoles;
  saveCameraConfig(cfg); cameraConfig = cfg;
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Camera policy saved.')}`);
});

// ── channel index ──────────────────────────────────────────────────────────
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
        <td style="width:32px;text-align:center;"><input type="checkbox" name="includedChannels" value="${ch.id}" ${!excluded?'checked':''} title="${excluded?'Excluded':'Included'}"></td>
        <td style="white-space:nowrap">${icon} ${ch.name}</td>
        <td><input type="text" name="desc_${ch.id}" value="${desc.replace(/"/g,'&quot;')}" placeholder="Channel description..." style="padding:.3rem .5rem;font-size:.82rem;"></td>
      </tr>`;
    }).join('');
    return `<tr><td colspan="3" style="background:var(--surface2);padding:.35rem .75rem;font-size:.7rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);">📁 ${cat}</td></tr>${rows}`;
  }).join('');

  const body = `
    <div class="page-title">CHANNEL INDEX</div>
    <div class="page-sub">Post a formatted clickable channel index. Edit descriptions and choose which channels to include.</div>
    ${flash}
    <form method="POST" action="/channel-index/post?guild=${guildId}">
      <div class="card">
        <div class="card-title">Post Channel Index</div>
        <div class="form-row"><label>Post to channel</label>
          <select name="targetChannelId">
            <option value="">— select a channel —</option>
            ${textChannels.map(c=>`<option value="${c.id}">#${c.name}</option>`).join('')}
          </select>
        </div>
        <button type="submit" class="btn btn-primary">📋 Post Channel Index</button>
      </div>
    </form>
    <form method="POST" action="/channel-index/save-descriptions?guild=${guildId}">
      <div class="card">
        <div class="card-title">Channels &amp; Descriptions</div>
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">✓ = included in index. Add descriptions to appear alongside channel links.</p>
        <table>
          <thead><tr><th style="width:32px;text-align:center;">✓</th><th>Channel</th><th>Description</th></tr></thead>
          <tbody>${channelRows}</tbody>
        </table>
        <div style="margin-top:1rem;"><button type="submit" class="btn btn-primary">💾 Save Descriptions &amp; Visibility</button></div>
      </div>
    </form>`;
  res.send(renderLayout({ title:'Channel Index', guildId, currentPath:'/channel-index', allowedGuildIds, username:req.session.userTag, body }));
});

app.post('/channel-index/save-descriptions', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const allChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type !== ChannelType.GuildCategory) : [];
  const all = loadAllDescriptions(); if (!all[guildId]) all[guildId] = {};
  for (const ch of allChannels) {
    const desc = req.body[`desc_${ch.id}`] || '';
    all[guildId][ch.id] = { name: ch.name, description: desc.trim() };
  }
  saveAllDescriptions(all);
  const included = (() => { const v = req.body.includedChannels; return v ? (Array.isArray(v)?v:[v]) : []; })();
  const excluded = allChannels.map(c=>c.id).filter(id=>!included.includes(id));
  ensureChannelIndexGuildConfig(guildId).excludedChannelIds = excluded;
  saveChannelIndexConfig(channelIndexConfig);
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

// ── speed match ────────────────────────────────────────────────────────────
app.get('/speed-match', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const guild = client.guilds.cache.get(guildId);
  const state = shuffleState.get(guildId);
  const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
  const running = cfg.enabled;
  const modeLabel = cfg.connectionMode==='role-based' ? 'Role-Based' : (cfg.minGroupSize===1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
  const nextAt = state?.nextShuffleAt ? new Date(state.nextShuffleAt).toLocaleTimeString() : '—';
  const textChannels  = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).sort((a,b)=>a.name.localeCompare(b.name)) : [];
  const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildVoice||c.type===ChannelType.GuildStageVoice).sort((a,b)=>a.name.localeCompare(b.name)) : [];
  const categories    = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildCategory).sort((a,b)=>a.rawPosition-b.rawPosition) : [];

  let eventCatSection = '';
  if (cfg.eventCategoryId) {
    const subChs = guild ? [...guild.channels.cache.values()].filter(c=>c.parentId===cfg.eventCategoryId).sort((a,b)=>a.rawPosition-b.rawPosition) : [];
    const cat = guild?.channels.cache.get(cfg.eventCategoryId);
    eventCatSection = `<div class="card"><div class="card-title">Event Category — ${cat?.name||cfg.eventCategoryId}</div>
      <table><thead><tr><th>Channel</th><th>Type</th></tr></thead><tbody>
        ${subChs.map(c=>`<tr><td>${c.type===ChannelType.GuildVoice?'🔊':'#'} ${c.name}</td><td style="color:var(--muted);font-size:.8rem;">${c.type===ChannelType.GuildVoice?'voice':'text'}</td></tr>`).join('')||'<tr><td colspan="2" style="color:var(--muted)">No channels yet.</td></tr>'}
      </tbody></table>
      ${!subChs.length?`<form method="POST" action="/speed-match/create-channels?guild=${guildId}" style="margin-top:1rem;"><button type="submit" class="btn btn-primary">➕ Create Standard Event Channels</button></form>`:''}
    </div>`;
  }

  const cloudRoomRows = (cfg.cloudRoomIds||[]).map(id=>{
    const ch=guild?.channels.cache.get(id);
    return `<tr><td>🔊 ${ch?.name||id}</td><td style="color:var(--muted);font-size:.8rem;">${id}</td><td><form method="POST" action="/speed-match/cloudroom/remove?guild=${guildId}" style="display:inline"><input type="hidden" name="roomId" value="${id}"><button type="submit" class="btn btn-danger" style="padding:.2rem .5rem;font-size:.75rem;">Remove</button></form></td></tr>`;
  }).join('');

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
    <div class="card">
      <div class="card-title">Session Controls</div>
      <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">Mode: <strong>${modeLabel}</strong> · Interval: <strong>${cfg.minIntervalMinutes}–${cfg.maxIntervalMinutes} min</strong></p>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;">
        <form method="POST" action="/speed-match/start?guild=${guildId}"><button type="submit" class="btn btn-primary" ${running?'disabled':''}>▶️ Start Session</button></form>
        <form method="POST" action="/speed-match/bell?guild=${guildId}"><button type="submit" class="btn btn-ghost" ${!running?'disabled':''}>🔔 Ring Bell Now</button></form>
        <form method="POST" action="/speed-match/stop?guild=${guildId}"><button type="submit" class="btn btn-danger" ${!running?'disabled':''}>⏹ End Session</button></form>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Quick Commands</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem;">
        ${[['/speed-match start','Start a session'],['/speed-match stop','Stop the session'],['/speed-match status','Check session status'],['/speed-match shuffle-now','Force a shuffle'],['/speed-match end-session','End + post summary'],['/speed-match set-group-size','Set group size'],['/speed-match set-interval','Set round interval'],['/speed-match add-lobby','Add a lobby VC'],['/speed-match set-category','Set event category']].map(([cmd,desc])=>`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:.55rem .8rem;"><code style="color:var(--magenta);font-size:.8rem;">${cmd}</code><div style="color:var(--muted);font-size:.75rem;margin-top:.2rem;">${desc}</div></div>`).join('')}
      </div>
    </div>
    <form method="POST" action="/speed-match/config?guild=${guildId}">
      <div class="card">
        <div class="card-title">Configuration</div>
        <div class="form-row"><label>Lobby voice channel</label>
          <select name="lobbyChannelId"><option value="">— select lobby —</option>${voiceChannels.map(c=>`<option value="${c.id}" ${cfg.lobbyChannelIds?.includes(c.id)?'selected':''}>🔊 ${c.name}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Event category (temp rooms created here)</label>
          <select name="eventCategoryId"><option value="">— select category —</option>${categories.map(c=>`<option value="${c.id}" ${cfg.eventCategoryId===c.id?'selected':''}>📁 ${c.name}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Matchups / announcements channel</label>
          <select name="matchupsChannelId"><option value="">— select channel —</option>${textChannels.map(c=>`<option value="${c.id}" ${cfg.matchupsChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Staff panel channel (staff only)</label>
          <select name="staffPanelChannelId"><option value="">— select channel —</option>${textChannels.map(c=>`<option value="${c.id}" ${cfg.staffPanelChannelId===c.id?'selected':''}>#${c.name}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Min round interval (minutes)</label><input type="number" name="minIntervalMinutes" value="${cfg.minIntervalMinutes??3}" min="1" max="60"></div>
        <div class="form-row"><label>Max round interval (minutes)</label><input type="number" name="maxIntervalMinutes" value="${cfg.maxIntervalMinutes??3}" min="1" max="60"></div>
        <button type="submit" class="btn btn-primary">💾 Save Configuration</button>
      </div>
    </form>
    ${eventCatSection}
    ${cloudRoomRows?`<div class="card"><div class="card-title">Cloud Rooms</div><table><thead><tr><th>Channel</th><th>ID</th><th></th></tr></thead><tbody>${cloudRoomRows}</tbody></table></div>`:''}
    <div class="card">
      <div class="card-title">Support Server</div>
      <p style="font-size:.85rem;color:var(--muted);margin-bottom:1rem;">Questions about Speed Match or the bot? Join the support server.</p>
      <a href="https://discord.gg/kea3NVHJW7" target="_blank" class="btn btn-primary">📨 Join Support Server</a>
    </div>`;
  res.send(renderLayout({ title:'Speed Match', guildId, currentPath:'/speed-match', allowedGuildIds, username:req.session.userTag, body }));
});

app.post('/speed-match/start', async (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.lobbyChannelIds?.length) return res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ Add a lobby channel first.')}`);
  const guild = client.guilds.cache.get(guildId);
  try { await startVcShuffle(guild, guildId, true); res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Session started!')}`); }
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
app.post('/speed-match/config', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (req.body.lobbyChannelId && !cfg.lobbyChannelIds.includes(req.body.lobbyChannelId)) cfg.lobbyChannelIds.push(req.body.lobbyChannelId);
  if (req.body.eventCategoryId !== undefined) cfg.eventCategoryId = req.body.eventCategoryId || null;
  if (req.body.matchupsChannelId !== undefined) cfg.matchupsChannelId = req.body.matchupsChannelId || null;
  if (req.body.staffPanelChannelId !== undefined) { cfg.staffPanelChannelId = req.body.staffPanelChannelId || null; cfg.staffPanelMessageId = null; }
  const min = parseInt(req.body.minIntervalMinutes); const max = parseInt(req.body.maxIntervalMinutes);
  if (!isNaN(min) && min>=1) cfg.minIntervalMinutes = min;
  if (!isNaN(max) && max>=1) cfg.maxIntervalMinutes = max;
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Configuration saved.')}`);
});
app.post('/speed-match/cloudroom/remove', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.cloudRoomIds = (cfg.cloudRoomIds||[]).filter(id=>id!==req.body.roomId);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Room removed.')}`);
});
app.post('/speed-match/create-channels', async (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const guild = client.guilds.cache.get(guildId);
  if (!guild || !cfg.eventCategoryId) return res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ Set an event category first.')}`);
  try {
    await guild.channels.create({ name:'matchups', type:ChannelType.GuildText, parent:cfg.eventCategoryId });
    await guild.channels.create({ name:'lobby', type:ChannelType.GuildVoice, parent:cfg.eventCategoryId });
    res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ Standard event channels created!')}`);
  } catch (err) { res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('❌ '+err.message)}`); }
});

// ── sticky posts ───────────────────────────────────────────────────────────
const STICKY_FILE = dataPath('sticky-posts.json');
function loadSticky() { try { return JSON.parse(fs.readFileSync(STICKY_FILE, 'utf-8')); } catch { return {}; } }
function saveSticky(d) { fs.writeFileSync(STICKY_FILE, JSON.stringify(d, null, 2)); }

const stickyLastMsg = {};
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const sticky = loadSticky(); const gSticky = sticky[msg.guildId]; if (!gSticky) return;
  const entry = gSticky[msg.channelId]; if (!entry?.content) return;
  try {
    if (stickyLastMsg[msg.channelId]) { const old = await msg.channel.messages.fetch(stickyLastMsg[msg.channelId]).catch(()=>null); if (old) await old.delete().catch(()=>{}); }
    const sent = await msg.channel.send({ content:`📌 ${entry.content}` }); stickyLastMsg[msg.channelId] = sent.id;
  } catch {}
});

// ── EMBED EDITOR helper (shared by sticky + autoresponder) ─────────────────
const EMBED_EDITOR_SCRIPT = `
<script>
// Component editor state
let __editorComponents = [];
let __editorIdCtr = 0;
const __uid = () => 'ec'+(++__editorIdCtr);

function __addComp(type, targetField) {
  const c = { id: __uid(), type, content:'', url:'' };
  __editorComponents.push(c);
  __renderEditor(targetField);
}
function __removeComp(id, targetField) {
  __editorComponents = __editorComponents.filter(c=>c.id!==id);
  __renderEditor(targetField);
}
function __moveComp(id, dir, targetField) {
  const idx = __editorComponents.findIndex(c=>c.id===id);
  if (idx<0) return;
  const to = idx+dir;
  if (to<0||to>=__editorComponents.length) return;
  [__editorComponents[idx],__editorComponents[to]]=[__editorComponents[to],__editorComponents[idx]];
  __renderEditor(targetField);
}
function __updateComp(id, key, val, targetField) {
  const c = __editorComponents.find(x=>x.id===id);
  if (c) { c[key]=val; __buildOutput(targetField); __renderSidePreview(); }
}
function __buildOutput(targetField) {
  const out = __editorComponents.map(c=>c.type==='text'?c.content:(c.url||'')).filter(Boolean).join('\\n\\n');
  const f = document.getElementById(targetField);
  if (f) f.value = out;
}
function __renderSidePreview() {
  const el = document.getElementById('__sidePreview');
  if (!el) return;
  if (!__editorComponents.length) { el.innerHTML='<div style="color:#72767d;font-style:italic;font-size:.8rem;">Nothing yet</div>'; return; }
  el.innerHTML = __editorComponents.map((c,i)=>{
    if (c.type==='text') return \`<div style="color:#dcddde;font-size:.87rem;white-space:pre-wrap;word-break:break-word;margin-bottom:.5rem;">\${c.content||'<span style="color:#4f545c;font-style:italic;">Empty text</span>'}</div>\`;
    if (c.type==='image') return c.url?\`<img src="\${c.url}" style="max-width:100%;border-radius:4px;margin-bottom:.5rem;display:block;" onerror="this.outerHTML='<div style=color:#72767d;font-size:.78rem;font-style:italic>⚠️ Image failed to load</div>'">\':<div style="color:#72767d;font-style:italic;font-size:.8rem;margin-bottom:.5rem;">🖼️ Image placeholder</div>\`;
    return '';
  }).join('');
}
function __renderEditor(targetField) {
  const el = document.getElementById('__editorCanvas');
  if (!el) return;
  if (!__editorComponents.length) {
    el.innerHTML=\`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;color:#555;gap:.5rem;padding:2rem;border:2px dashed rgba(255,0,255,.2);border-radius:6px;text-align:center;min-height:120px;"><div style="font-size:1.5rem;">📭</div><div style="font-size:.82rem;">No components — add text or image below.</div></div>\`;
    __buildOutput(targetField); __renderSidePreview(); return;
  }
  el.innerHTML = __editorComponents.map((c,i)=>\`
    <div style="background:#181818;border:1px solid rgba(255,0,255,.18);border-radius:6px;margin-bottom:.5rem;">
      <div style="display:flex;align-items:center;gap:.5rem;padding:.4rem .7rem;border-bottom:1px solid rgba(255,0,255,.12);user-select:none;">
        <span style="color:#555;font-size:.9rem;">⠿⠿</span>
        <span style="font-size:.7rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#FF00FF;">\${c.type==='text'?'✏️ Text':'🖼️ Image'}</span>
        <div style="margin-left:auto;display:flex;gap:.3rem;">
          <button type="button" onclick="__moveComp('\${c.id}',-1,'\${targetField}')" style="background:transparent;border:1px solid rgba(255,0,255,.2);color:#e0e0e0;border-radius:3px;padding:.15rem .4rem;font-size:.7rem;cursor:pointer;" \${i===0?'disabled':''}>▲</button>
          <button type="button" onclick="__moveComp('\${c.id}',1,'\${targetField}')" style="background:transparent;border:1px solid rgba(255,0,255,.2);color:#e0e0e0;border-radius:3px;padding:.15rem .4rem;font-size:.7rem;cursor:pointer;" \${i===__editorComponents.length-1?'disabled':''}>▼</button>
          <button type="button" onclick="__removeComp('\${c.id}','\${targetField}')" style="background:#c0392b;border:none;color:#fff;border-radius:3px;padding:.15rem .4rem;font-size:.7rem;cursor:pointer;">🗑</button>
        </div>
      </div>
      <div style="padding:.7rem;">
        \${c.type==='text'?\`
          <textarea rows="3" maxlength="4000" oninput="__updateComp('\${c.id}','content',this.value,'\${targetField}')" placeholder="Content of the text component." style="width:100%;background:#111;border:1px solid rgba(255,0,255,.18);color:#e0e0e0;padding:.4rem .6rem;border-radius:4px;font-size:.84rem;font-family:inherit;resize:vertical;">\${c.content}</textarea>
          <div style="font-size:.68rem;color:#555;text-align:right;">\${c.content.length}/4000</div>
        \`:\`
          <input type="text" value="\${c.url}" oninput="__updateComp('\${c.id}','url',this.value,'\${targetField}');__refreshImg('__img_\${c.id}',this.value)" placeholder="https://example.com/image.png" style="width:100%;background:#111;border:1px solid rgba(255,0,255,.18);color:#e0e0e0;padding:.4rem .6rem;border-radius:4px;font-size:.84rem;font-family:inherit;margin-bottom:.5rem;">
          <div id="__img_\${c.id}" style="background:#111;border-radius:4px;overflow:hidden;border:1px solid rgba(255,0,255,.12);display:flex;align-items:center;justify-content:center;min-height:60px;">
            \${c.url?\`<img src="\${c.url}" style="max-width:100%;max-height:160px;object-fit:contain;" onerror="this.parentElement.innerHTML='<div style=color:#555;font-size:.8rem;padding:.75rem;>⚠️ Image failed to load</div>'">\`:'<div style="color:#555;font-size:.8rem;padding:.75rem;">🖼️ Add Media — paste an image URL above</div>'}
          </div>
        \`}
      </div>
    </div>
  \`).join('');
  __buildOutput(targetField); __renderSidePreview();
}
function __refreshImg(elId, url) {
  const el = document.getElementById(elId); if (!el) return;
  if (!url) { el.innerHTML='<div style="color:#555;font-size:.8rem;padding:.75rem;">🖼️ Add Media — paste an image URL above</div>'; return; }
  el.innerHTML=\`<img src="\${url}" style="max-width:100%;max-height:160px;object-fit:contain;" onerror="this.parentElement.innerHTML='<div style=color:#555;font-size:.8rem;padding:.75rem;>⚠️ Image failed to load</div>'">\`;
}
function __initEditor(targetField, existingContent) {
  __editorComponents = [];
  if (existingContent) {
    existingContent.split(/\\n\\n+/).forEach(part => {
      part = part.trim(); if (!part) return;
      if (part.match(/^https?:\\/\\/.+\\.(png|jpg|jpeg|gif|webp)(\\?.*)?$/i)) __editorComponents.push({ id:__uid(), type:'image', url:part, content:'' });
      else __editorComponents.push({ id:__uid(), type:'text', content:part, url:'' });
    });
  }
  __renderEditor(targetField);
}
</script>`;

function embedEditorHTML(targetFieldId, existingContent = '', label = 'Message') {
  const escaped = (existingContent||'').replace(/\\/g,'\\\\').replace(/`/g,'\\`');
  return `
    <div style="display:flex;gap:1rem;margin-top:.5rem;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;gap:.4rem;margin-bottom:.5rem;flex-wrap:wrap;">
          <button type="button" class="btn btn-ghost" style="font-size:.78rem;padding:.3rem .7rem;" onclick="__addComp('text','${targetFieldId}')">✏️ Add Text</button>
          <button type="button" class="btn btn-ghost" style="font-size:.78rem;padding:.3rem .7rem;" onclick="__addComp('image','${targetFieldId}')">🖼️ Add Image</button>
        </div>
        <div id="__editorCanvas"></div>
      </div>
      <div style="width:220px;flex-shrink:0;">
        <div style="font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--magenta);margin-bottom:.4rem;">Discord Preview</div>
        <div id="__sidePreview" style="background:#36393f;border-radius:6px;padding:.75rem 1rem;border:1px solid rgba(255,255,255,.06);min-height:60px;">
          <div style="color:#72767d;font-style:italic;font-size:.8rem;">Nothing yet</div>
        </div>
      </div>
    </div>
    <script>document.addEventListener('DOMContentLoaded',()=>__initEditor('${targetFieldId}',\`${escaped}\`));</script>`;
}

app.get('/sticky', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const sticky = loadSticky();
  const gSticky = sticky[guildId] || {};
  const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
  const editChannelId = req.query.edit || null;
  const channels = guild ? [...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText||c.type===ChannelType.GuildVoice||c.type===ChannelType.PublicThread||c.type===ChannelType.GuildForum).sort((a,b)=>a.name.localeCompare(b.name)) : [];

  const chanSearch = `<input type="text" placeholder="Search channels (#)..." oninput="this.nextElementSibling.querySelectorAll('option').forEach(o=>{o.hidden=o.value&&!o.text.toLowerCase().includes(this.value.toLowerCase());})" style="margin-bottom:.4rem;">`;

  const existingRows = Object.entries(gSticky).map(([chId, entry]) => {
    const ch = guild?.channels.cache.get(chId);
    if (chId === editChannelId) {
      return `<tr style="background:var(--magenta-faint);">
        <td colspan="3">
          <form method="POST" action="/sticky/save?guild=${guildId}" style="padding:.6rem 0;">
            <input type="hidden" name="channelId" value="${chId}">
            <strong style="color:var(--magenta);font-size:.82rem;">Editing: #${ch?.name||chId}</strong>
            <div style="margin-top:.5rem;">${embedEditorHTML('stickyContent', entry.content, 'Sticky message')}</div>
            <textarea name="content" id="stickyContent" style="display:none;">${entry.content.replace(/</g,'&lt;')}</textarea>
            <div style="display:flex;gap:.5rem;margin-top:.75rem;">
              <button type="submit" class="btn btn-primary" style="font-size:.8rem;padding:.3rem .75rem;">💾 Save</button>
              <a href="/sticky?guild=${guildId}" class="btn btn-ghost" style="font-size:.8rem;padding:.3rem .75rem;">Cancel</a>
            </div>
          </form>
        </td>
      </tr>`;
    }
    return `<tr>
      <td style="white-space:nowrap">#${ch?.name||chId}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.85rem;">${entry.content.replace(/</g,'&lt;')}</td>
      <td style="white-space:nowrap;display:flex;gap:.4rem;">
        <a href="/sticky?guild=${guildId}&edit=${chId}" class="btn btn-ghost" style="padding:.25rem .6rem;font-size:.75rem;">✏️ Edit</a>
        <form method="POST" action="/sticky/delete?guild=${guildId}" style="display:inline"><input type="hidden" name="channelId" value="${chId}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">🗑 Remove</button></form>
      </td>
    </tr>`;
  }).join('');

  const body = `${EMBED_EDITOR_SCRIPT}
    <div class="page-title">STICKY POSTS</div>
    <div class="page-sub">Messages that re-post at the bottom of a channel whenever someone else sends a message.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Add Sticky Post</div>
      <form method="POST" action="/sticky/save?guild=${guildId}">
        <div class="form-row"><label>Channel</label>
          ${chanSearch}
          <select name="channelId"><option value="">— select channel —</option>
            ${channels.map(c=>`<option value="${c.id}">${c.type===ChannelType.GuildVoice?'🔊':'#'} ${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>Message (use the editor below to add text + images)</label>
          <textarea name="content" id="newStickyContent" placeholder="Your sticky message..." rows="3" style="margin-bottom:.4rem;"></textarea>
          ${embedEditorHTML('newStickyContent')}
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:.75rem;">📌 Set Sticky</button>
      </form>
    </div>
    ${existingRows ? `<div class="card"><div class="card-title">Active Sticky Posts (${Object.keys(gSticky).length})</div><table><thead><tr><th>Channel</th><th>Message</th><th style="width:140px">Actions</th></tr></thead><tbody>${existingRows}</tbody></table></div>` : '<div class="card"><p style="color:var(--muted);">No sticky posts configured yet.</p></div>'}`;
  res.send(renderLayout({ title:'Sticky Posts', guildId, currentPath:'/sticky', allowedGuildIds, username:req.session.userTag, body }));
});

app.post('/sticky/save', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const { channelId, content } = req.body;
  if (!channelId || !content?.trim()) return res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('❌ Channel and message are required.')}`);
  const sticky = loadSticky(); if (!sticky[guildId]) sticky[guildId] = {};
  sticky[guildId][channelId] = { content: content.trim() };
  saveSticky(sticky);
  res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post saved.')}`);
});
app.post('/sticky/delete', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const sticky = loadSticky(); if (sticky[guildId]) delete sticky[guildId][req.body.channelId];
  saveSticky(sticky);
  res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post removed.')}`);
});

// ── auto responders ────────────────────────────────────────────────────────
const AR_FILE = dataPath('autoresponders.json');
function loadAR() { try { return JSON.parse(fs.readFileSync(AR_FILE, 'utf-8')); } catch { return {}; } }
function saveAR(d) { fs.writeFileSync(AR_FILE, JSON.stringify(d, null, 2)); }

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guildId) return;
  const ar = loadAR(); const gAR = ar[msg.guildId]; if (!gAR?.length) return;
  const lower = msg.content.toLowerCase();
  for (const rule of gAR) {
    const match = rule.matchType==='exact' ? lower===rule.trigger.toLowerCase() : lower.includes(rule.trigger.toLowerCase());
    if (match) { await msg.channel.send(rule.response).catch(()=>{}); break; }
  }
});

app.get('/autoresponder', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const ar = loadAR(); const gAR = ar[guildId] || [];
  const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌')?'flash-err':'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';
  const editIdx = req.query.edit !== undefined ? parseInt(req.query.edit) : -1;

  const rows = gAR.map((rule, i) => {
    if (i === editIdx) return `<tr style="background:var(--magenta-faint);">
      <td colspan="4">
        <form method="POST" action="/autoresponder/update?guild=${guildId}" style="padding:.6rem 0;">
          <input type="hidden" name="index" value="${i}">
          <strong style="color:var(--magenta);font-size:.82rem;">Editing rule #${i+1}</strong>
          <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.5rem;">
            <div style="flex:1;min-width:160px;"><label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:.25rem;">Trigger</label><input type="text" name="trigger" value="${rule.trigger.replace(/"/g,'&quot;')}"></div>
            <div style="min-width:140px;"><label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:.25rem;">Match type</label><select name="matchType"><option value="contains" ${rule.matchType==='contains'?'selected':''}>Contains</option><option value="exact" ${rule.matchType==='exact'?'selected':''}>Exact</option></select></div>
          </div>
          <div style="margin-top:.6rem;">
            <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:.25rem;">Response (use the editor below)</label>
            <textarea name="response" id="arEditContent_${i}" rows="3" style="margin-bottom:.4rem;">${rule.response.replace(/</g,'&lt;')}</textarea>
            ${embedEditorHTML(`arEditContent_${i}`, rule.response)}
          </div>
          <div style="display:flex;gap:.5rem;margin-top:.75rem;">
            <button type="submit" class="btn btn-primary" style="font-size:.8rem;padding:.3rem .75rem;">💾 Save</button>
            <a href="/autoresponder?guild=${guildId}" class="btn btn-ghost" style="font-size:.8rem;padding:.3rem .75rem;">Cancel</a>
          </div>
        </form>
      </td>
    </tr>`;
    return `<tr>
      <td><code style="color:var(--magenta)">${rule.trigger.replace(/</g,'&lt;')}</code></td>
      <td><span style="font-size:.74rem;background:var(--surface2);padding:.12rem .4rem;border-radius:3px;">${rule.matchType}</span></td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.85rem;">${rule.response.replace(/</g,'&lt;')}</td>
      <td style="white-space:nowrap;display:flex;gap:.4rem;">
        <a href="/autoresponder?guild=${guildId}&edit=${i}" class="btn btn-ghost" style="padding:.25rem .6rem;font-size:.75rem;">✏️ Edit</a>
        <form method="POST" action="/autoresponder/delete?guild=${guildId}" style="display:inline"><input type="hidden" name="index" value="${i}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">🗑 Remove</button></form>
      </td>
    </tr>`;
  }).join('');

  const body = `${EMBED_EDITOR_SCRIPT}
    <div class="page-title">AUTO RESPONDERS</div>
    <div class="page-sub">Bot replies automatically when a trigger word or phrase is detected in any message.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Add Auto Responder</div>
      <form method="POST" action="/autoresponder/save?guild=${guildId}">
        <div class="form-row"><label>Trigger phrase</label><input type="text" name="trigger" placeholder="e.g. !rules or when does the event start"></div>
        <div class="form-row"><label>Match type</label>
          <select name="matchType"><option value="contains">Contains — trigger appears anywhere in the message</option><option value="exact">Exact match — full message must equal trigger</option></select>
        </div>
        <div class="form-row">
          <label>Response (use the editor below to add text + images)</label>
          <textarea name="response" id="newARContent" rows="3" style="margin-bottom:.4rem;" placeholder="Bot's reply..."></textarea>
          ${embedEditorHTML('newARContent')}
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:.75rem;">➕ Add Responder</button>
      </form>
    </div>
    ${rows ? `<div class="card"><div class="card-title">Active Responders (${gAR.length})</div><table><thead><tr><th>Trigger</th><th>Match</th><th>Response</th><th style="width:130px">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card"><p style="color:var(--muted);">No auto responders configured yet.</p></div>'}`;
  res.send(renderLayout({ title:'Auto Responders', guildId, currentPath:'/autoresponder', allowedGuildIds, username:req.session.userTag, body }));
});

app.post('/autoresponder/save', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const { trigger, matchType, response } = req.body;
  if (!trigger?.trim() || !response?.trim()) return res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('❌ Trigger and response are required.')}`);
  const ar = loadAR(); if (!ar[guildId]) ar[guildId] = [];
  ar[guildId].push({ trigger:trigger.trim(), matchType:matchType||'contains', response:response.trim() });
  saveAR(ar);
  res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder added.')}`);
});
app.post('/autoresponder/update', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const idx = parseInt(req.body.index); const { trigger, matchType, response } = req.body;
  if (!trigger?.trim() || !response?.trim()) return res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('❌ Trigger and response are required.')}`);
  const ar = loadAR();
  if (!ar[guildId]?.[idx]) return res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('❌ Responder not found.')}`);
  ar[guildId][idx] = { trigger:trigger.trim(), matchType:matchType||'contains', response:response.trim() };
  saveAR(ar);
  res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder updated.')}`);
});
app.post('/autoresponder/delete', (req, res) => {
  const guildId = resolveGuildId(req); if (!guildId) return res.redirect('/');
  const idx = parseInt(req.body.index); const ar = loadAR();
  if (ar[guildId]) ar[guildId].splice(idx, 1);
  saveAR(ar);
  res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder removed.')}`);
});

// ── temp roles ─────────────────────────────────────────────────────────────
const TR_FILE = dataPath('temproles.json');
function loadTR() { try { return JSON.parse(fs.readFileSync(TR_FILE, 'utf-8')); } catch { return {}; } }
function saveTR(d) { fs.writeFileSync(TR_FILE, JSON.stringify(d, null, 2)); }

// VC join/leave role
client.on('voiceStateUpdate', async (oldState, newState) => {
  const tr = loadTR();
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const cfg = tr[guildId];
  if (!cfg?.vcRoleId) return;
  const guild = newState.guild || oldState.guild;

  // Monitored channels filter — if set, only fire for those channels
  const monitored = cfg.monitoredChannelIds?.length ? cfg.monitoredChannelIds : null;

  const justJoined = !oldState.channelId && !!newState.channelId;
  const justLeft   = !!oldState.channelId && !newState.channelId;
  const switched   = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;

  // ── Helper: build the join message and post it ──────────────────────────
  async function postJoinMessage(member, vcChannel) {
    if (!member || member.user.bot) return;

    // Roles to tag in the message
    const tagRoleIds = cfg.tagRoleIds?.length ? cfg.tagRoleIds : [];
    const roleMentions = tagRoleIds.map(id => `<@&${id}>`).join(' ');

    // Custom message with variable substitution
    const buildMsg = (custom) => custom
      ? custom
          .replace(/{user}/g,    `${member}`)
          .replace(/{channel}/g, vcChannel?.name || '')
          .replace(/{mention}/g, `<#${vcChannel?.id}>`)
          .replace(/{roles}/g,   roleMentions)
      : `🔊 ${member} joined **${vcChannel?.name || 'a voice channel'}**${roleMentions ? ` · ${roleMentions}` : ''}`;

    const nonBotSize = vcChannel?.members?.filter(m => !m.user.bot).size ?? 0;
    const isNewlyActive = nonBotSize === 1; // channel just went 0→1

    // 1. Post inside the VC's linked text channel (vcTextChannelId)
    if (cfg.vcTextChannelId) {
      const vcText = guild.channels.cache.get(cfg.vcTextChannelId);
      if (vcText) await vcText.send(buildMsg(cfg.announceMsg)).catch(() => {});
    }

    // 2. Post to the separate announcement channel when VC goes 0→1
    if (cfg.announceChannelId && isNewlyActive) {
      const announceChannel = guild.channels.cache.get(cfg.announceChannelId);
      if (announceChannel) await announceChannel.send(buildMsg(cfg.announceMsg)).catch(() => {});
    }
  }

  // ── Joined a VC from outside ────────────────────────────────────────────
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

  // ── Switched rooms — check if new room went 0→1 ─────────────────────────
  if (switched) {
    const member = newState.member;
    if (member && !member.user.bot) {
      const newCh = newState.channel;
      if (!monitored || monitored.includes(newCh?.id)) {
        const nonBotSize = newCh?.members?.filter(m => !m.user.bot).size ?? 0;
        if (nonBotSize === 1) await postJoinMessage(member, newCh);
      }
      // If leaving a monitored channel to an unmonitored one, remove role
      if (monitored && !monitored.includes(newCh?.id) && monitored.includes(oldState.channelId)) {
        await member.roles.remove(cfg.vcRoleId, 'HSC: left monitored VC').catch(() => {});
      }
      // If joining a monitored channel from an unmonitored one, add role
      if (monitored && monitored.includes(newCh?.id) && !monitored.includes(oldState.channelId)) {
        await member.roles.add(cfg.vcRoleId, 'HSC: entered monitored VC').catch(() => {});
      }
    }
  }

  // ── Left a VC entirely ──────────────────────────────────────────────────
  if (justLeft) {
    const member = oldState.member;
    if (member && !member.user.bot) {
      if (!monitored || monitored.includes(oldState.channelId)) {
        await member.roles.remove(cfg.vcRoleId, 'HSC: left VC').catch(() => {});
      }
    }
  }
});

// Timed button role — track active timers in memory
const timedRoleTimers = new Map();

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('temprole:')) return;
  const roleId = interaction.customId.replace('temprole:', '');
  const tr = loadTR();
  const cfg = tr[interaction.guildId];
  const rule = cfg?.timedRoles?.find(r => r.roleId === roleId);
  if (!rule) return await interaction.reply({ content: '❌ Role not found.', ephemeral: true });

  const member = interaction.member;
  const key = `${interaction.guildId}:${interaction.user.id}:${roleId}`;

  if (timedRoleTimers.has(key)) {
    return await interaction.reply({ content: `⏳ You already have this role. It will expire automatically.`, ephemeral: true });
  }

  await member.roles.add(roleId, `HSC: timed role (${rule.durationMinutes}m)`).catch(() => {});
  await interaction.reply({ content: `✅ You've been given the <@&${roleId}> role for ${rule.durationMinutes} minute(s).`, ephemeral: true });

  const timer = setTimeout(async () => {
    await member.roles.remove(roleId, 'HSC: timed role expired').catch(() => {});
    timedRoleTimers.delete(key);
  }, rule.durationMinutes * 60 * 1000);

  timedRoleTimers.set(key, timer);
});

app.get('/temproles', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const tr = loadTR();
  const cfg = tr[guildId] || {};
  const roles = guild ? [...guild.roles.cache.values()].filter(r => r.id !== guild.id).sort((a,b) => b.position - a.position) : [];
  const textChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const voiceChannels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).sort((a,b) => a.name.localeCompare(b.name)) : [];
  const flash = req.query.flash ? `<div class="flash ${req.query.flash.includes('❌') ? 'flash-err' : 'flash-ok'}">${decodeURIComponent(req.query.flash)}</div>` : '';

  const monitoredIds = cfg.monitoredChannelIds || [];
  const tagRoleIds   = cfg.tagRoleIds || [];

  // Shared inline search helper
  const srch = `<script>function fsearch(inp,sel){const v=inp.value.toLowerCase();sel.querySelectorAll('option').forEach(o=>{o.hidden=o.value&&!o.text.toLowerCase().includes(v);});}</script>`;

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
          <input type="text" placeholder="Search #..." oninput="fsearch(this,this.nextElementSibling)" style="width:100px;padding:.2rem .4rem;font-size:.78rem;">
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
    ${srch}
    <div class="page-title">TEMP ROLES</div>
    <div class="page-sub">VC presence roles and timed button roles.</div>
    ${flash}

    <form method="POST" action="/temproles/vc/save?guild=${guildId}">
      <div class="card">
        <div class="card-title">VC Role — Applied on Join, Removed on Leave</div>
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">
          The role is applied when a member joins any monitored voice channel (or any VC if none selected), and removed on leave.<br>
          The join message posts into the <strong>VC text channel</strong> every join, and into the <strong>announcement channel</strong> only when the VC goes from 0 → 1 person (including room switches).
        </p>

        <div class="form-row"><label>Role to apply on VC join</label>
          <input type="text" placeholder="Search roles..." oninput="fsearch(this,this.nextElementSibling)" style="margin-bottom:.3rem;">
          <select name="vcRoleId"><option value="">— none —</option>${roleOpts(cfg.vcRoleId)}</select>
        </div>

        <div class="form-row">
          <label>Monitored voice channels — only fire for these (leave blank for all VCs)</label>
          <input type="text" placeholder="Search channels #..." oninput="filterList(this,'monVCList')" style="margin-bottom:.35rem;">
          <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);" id="monVCList">
            ${voiceChannels.map(c => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;">
              <input type="checkbox" name="monitoredChannelIds" value="${c.id}" ${monitoredIds.includes(c.id) ? 'checked' : ''}>
              🔊 ${c.name}${c.parent ? ` <span style="color:var(--muted);font-size:.73rem;">(${c.parent.name})</span>` : ''}
            </label>`).join('')}
          </div>
          <script>function filterList(inp,listId){const v=inp.value.toLowerCase();document.querySelectorAll('#'+listId+' label').forEach(l=>{l.style.display=l.textContent.toLowerCase().includes(v)?'':'none';});}</script>
        </div>

        <div class="form-row"><label>Roles to @tag in join message (optional)</label>
          <input type="text" placeholder="Search roles..." oninput="filterList(this,'tagRoleList')" style="margin-bottom:.35rem;">
          <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--surface2);" id="tagRoleList">
            ${roles.map(r => `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;font-size:.84rem;cursor:pointer;">
              <input type="checkbox" name="tagRoleIds" value="${r.id}" ${tagRoleIds.includes(r.id) ? 'checked' : ''}>
              @${r.name}
            </label>`).join('')}
          </div>
        </div>

        <div class="form-row"><label>VC text channel — join message posts here every time</label>
          <input type="text" placeholder="Search #..." oninput="fsearch(this,this.nextElementSibling)" style="margin-bottom:.3rem;">
          <select name="vcTextChannelId"><option value="">— none —</option>${chanOpts(cfg.vcTextChannelId)}</select>
        </div>

        <div class="form-row"><label>Announcement channel — posts only when VC goes 0 → 1 person</label>
          <input type="text" placeholder="Search #..." oninput="fsearch(this,this.nextElementSibling)" style="margin-bottom:.3rem;">
          <select name="announceChannelId"><option value="">— none —</option>${chanOpts(cfg.announceChannelId)}</select>
        </div>

        <div class="form-row"><label>Custom join message (optional)</label>
          <input type="text" name="announceMsg" value="${(cfg.announceMsg||'').replace(/"/g,'&quot;')}" placeholder="{user} joined {channel}! {roles}">
          <span style="font-size:.74rem;color:var(--muted);">Variables: <code>{user}</code> <code>{channel}</code> <code>{mention}</code> <code>{roles}</code></span>
        </div>

        <button type="submit" class="btn btn-primary">💾 Save VC Role Config</button>
      </div>
    </form>

    <form method="POST" action="/temproles/timed/save?guild=${guildId}">
      <div class="card">
        <div class="card-title">Add Timed Button Role</div>
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">Members click a button in Discord to receive a role temporarily. It's removed automatically when the timer expires.</p>
        <div class="form-row"><label>Role</label>
          <input type="text" placeholder="Search roles..." oninput="fsearch(this,this.nextElementSibling)" style="margin-bottom:.3rem;">
          <select name="roleId"><option value="">— select role —</option>${roleOpts('')}</select>
        </div>
        <div class="form-row"><label>Duration (minutes)</label><input type="number" name="durationMinutes" value="30" min="1" max="10080"></div>
        <button type="submit" class="btn btn-primary">➕ Add Timed Role</button>
      </div>
    </form>

    ${timedRows ? `
    <div class="card">
      <div class="card-title">Active Timed Roles — Post Button to Channel</div>
      <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem;">Pick a channel and click 📤 Post to drop the button there. Members click it to get the role.</p>
      <table>
        <thead><tr><th>Role</th><th>Duration</th><th>Post button to…</th><th></th></tr></thead>
        <tbody>${timedRows}</tbody>
      </table>
    </div>` : '<div class="card"><p style="color:var(--muted)">No timed roles yet — add one above.</p></div>'}`;

  res.send(renderLayout({ title: 'Temp Roles', guildId, currentPath: '/temproles', allowedGuildIds, username: req.session.userTag, body }));
});

app.post('/temproles/vc/save', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const tr = loadTR();
  if (!tr[guildId]) tr[guildId] = {};
  const mc = req.body.monitoredChannelIds;
  const tr2 = req.body.tagRoleIds;
  tr[guildId].vcRoleId            = req.body.vcRoleId || null;
  tr[guildId].vcTextChannelId     = req.body.vcTextChannelId || null;
  tr[guildId].announceChannelId   = req.body.announceChannelId || null;
  tr[guildId].announceMsg         = req.body.announceMsg?.trim() || null;
  tr[guildId].monitoredChannelIds = mc ? (Array.isArray(mc) ? mc : [mc]) : [];
  tr[guildId].tagRoleIds          = tr2 ? (Array.isArray(tr2) ? tr2 : [tr2]) : [];
  saveTR(tr);
  res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ VC role config saved.')}`);
});

app.post('/temproles/timed/save', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const { roleId, durationMinutes } = req.body;
  if (!roleId) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Select a role.')}`);
  const tr = loadTR();
  if (!tr[guildId]) tr[guildId] = {};
  if (!tr[guildId].timedRoles) tr[guildId].timedRoles = [];
  tr[guildId].timedRoles.push({ roleId, durationMinutes: parseInt(durationMinutes) || 30 });
  saveTR(tr);
  res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Timed role added.')}`);
});

app.post('/temproles/timed/postbutton', async (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const { roleId, channelId, label, durationMinutes } = req.body;
  if (!channelId) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Select a channel to post to.')}`);
  const guild = client.guilds.cache.get(guildId);
  const ch = guild?.channels.cache.get(channelId);
  if (!ch) return res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Channel not found.')}`);
  try {
    const role = guild.roles.cache.get(roleId);
    const btn = new ButtonBuilder().setCustomId(`temprole:${roleId}`).setLabel(label?.trim() || 'Get Role').setStyle(ButtonStyle.Primary);
    await ch.send({
      content: `Click the button below to receive the **${role?.name || 'role'}** for ${durationMinutes} minute(s).`,
      components: [new ActionRowBuilder().addComponents(btn)],
    });
    res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Button posted to #' + ch.name)}`);
  } catch (err) {
    res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('❌ Error: ' + err.message)}`);
  }
});

app.post('/temproles/timed/delete', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const idx = parseInt(req.body.index);
  const tr = loadTR();
  if (tr[guildId]?.timedRoles) tr[guildId].timedRoles.splice(idx, 1);
  saveTR(tr);
  res.redirect(`/temproles?guild=${guildId}&flash=${encodeURIComponent('✅ Timed role removed.')}`);
});

// ── tos / privacy ──────────────────────────────────────────────────────────
app.get('/tos', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  const body = `<div class="page-title">TERMS OF SERVICE</div><div class="card"><p style="color:var(--muted);font-size:.9rem;line-height:1.8">HIGH-SPEED CONNECTION BOT may be used only in accordance with Discord's Terms of Service. Session data is stored in memory only and discarded when the session ends. No audio or video is recorded. The bot software is owned by HIGH-SPEED CONNECTION BOT. You may not copy, redistribute, sell, sublicense, or commercially exploit it without authorization.</p></div>`;
  res.send(renderLayout({ title: 'Terms of Service', guildId, currentPath: '/tos', allowedGuildIds, username: req.session.userTag, body }));
});

app.get('/privacy', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  const body = `<div class="page-title">PRIVACY POLICY</div><div class="card"><p style="color:var(--muted);font-size:.9rem;line-height:1.8">We collect your Discord username and guild membership via OAuth2 solely to authenticate you and show the servers you manage. During an active event, pair/skip history is stored in memory only and discarded when the session ends — never written to disk. Dashboard login info is stored in an encrypted session file and expires after 7 days. We do not sell or share your data with third parties.</p></div>`;
  res.send(renderLayout({ title: 'Privacy Policy', guildId, currentPath: '/privacy', allowedGuildIds, username: req.session.userTag, body }));
});

// ── start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => { console.log(`[dashboard] Listening on port ${PORT}`); });
client.login(TOKEN);
