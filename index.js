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
  const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT Configuration')
    .setDescription('Select a module to configure below. Everything saves instantly.');
  const moduleSelect = new StringSelectMenuBuilder().setCustomId('setup:main:select').setPlaceholder('Select a module to configure...')
    .addOptions(
      { label: 'Camera Policy',  description: 'Cameras-on voice channel policy',             value: 'camera',   emoji: '📷' },
      { label: 'Channel Index',  description: 'Exclusions & descriptions for /channel-index', value: 'chindex',  emoji: '#️⃣' },
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(moduleSelect)] };
}

function buildCameraMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId); const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('📷 Camera Policy Configuration')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
      `**Timing:** ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning\n` +
      `**Announcement:** ${cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not set'}\n` +
      `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Monitored Categories:** ${catCount ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Exempt Roles:** ${cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : 'Not set'}`
    );
  const topRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:camera:timing').setLabel('Set Timing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:categories-menu').setLabel('🗂 Categories').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  const channelSelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:channels:select').setPlaceholder('Select monitored voice channels...').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(0).setMaxValues(25);
  if (cfg.monitoredChannels.length) channelSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));
  const roleSelect = new RoleSelectMenuBuilder().setCustomId('setup:camera:exempt:select').setPlaceholder('Select exempt role(s)...').setMinValues(0).setMaxValues(25);
  if (cfg.exemptRoles.length) roleSelect.setDefaultRoles(...cfg.exemptRoles.slice(0, 25));
  return { embeds: [embed], components: [topRow, new ActionRowBuilder().addComponents(channelSelect), new ActionRowBuilder().addComponents(roleSelect)] };
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
      const choice = interaction.values[0];
      if (choice === 'camera') return interaction.update(buildCameraMenuMessage(guildId));
      return;
    }
    if (id === 'setup:camera:menu')            return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:camera:categories-menu') return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    if (id === 'setup:camera:toggle') {
      const cfg = ensureGuildConfig(guildId); cfg.enabled = !cfg.enabled;
      const saved = saveCameraConfig(cameraConfig);
      if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
      await interaction.update(buildCameraMenuMessage(guildId));
      if (!saved) await interaction.followUp({ content: '⚠️ Save failed — check Fly.io logs for DATA_DIR write error.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === 'setup:camera:channels:select') {
      ensureGuildConfig(guildId).monitoredChannels = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:categories:select') {
      ensureGuildConfig(guildId).monitoredCategoryIds = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    }
    if (id === 'setup:camera:exempt:select') {
      ensureGuildConfig(guildId).exemptRoles = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:timing') {
      const cfg = ensureGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:camera:timing:modal').setTitle('Camera Policy Timing');
      const graceInput   = new TextInputBuilder().setCustomId('grace').setLabel('Grace period (minutes, silent)').setStyle(TextInputStyle.Short).setValue(String(cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES)).setRequired(true);
      const warningInput = new TextInputBuilder().setCustomId('warning').setLabel('Warning period (minutes, after reminder)').setStyle(TextInputStyle.Short).setValue(String(cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES)).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(graceInput), new ActionRowBuilder().addComponents(warningInput));
      return interaction.showModal(modal);
    }
    if (id === 'setup:camera:timing:modal') {
      const grace = parseInt(interaction.fields.getTextInputValue('grace'), 10);
      const warning = parseInt(interaction.fields.getTextInputValue('warning'), 10);
      if (!Number.isInteger(grace) || !Number.isInteger(warning) || grace < 0 || warning < 1)
        return interaction.reply({ content: '❌ Grace must be 0+ and warning must be 1+ (whole numbers).', flags: MessageFlags.Ephemeral });
      const cfg = ensureGuildConfig(guildId); cfg.graceMinutes = grace; cfg.warningMinutes = warning;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
  } catch (err) {
    console.error('[setup] interaction error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

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
app.get('/camera', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig()[guildId] || {};
  const guild = client.guilds.cache.get(guildId);
  const channels = guild ? [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildVoice) : [];
  const roles = guild ? [...guild.roles.cache.values()].filter(r => r.id !== guild.id) : [];
  const flash = req.query.flash ? `<div class="flash flash-ok">${decodeURIComponent(req.query.flash)}</div>` : '';
  const monitored = cfg.monitoredChannels || [];
  const exempt = cfg.exemptRoleIds || [];
  const body = `
    <div class="page-title">CAMERA POLICY</div>
    <div class="page-sub">Enforce camera-on rules in voice channels.</div>
    ${flash}
    <form method="POST" action="/camera/save?guild=${guildId}">
      <div class="card">
        <div class="card-title">Status</div>
        <div class="toggle"><input type="checkbox" id="enabled" name="enabled" ${cfg.enabled ? 'checked' : ''}><label for="enabled">Camera policy enabled</label></div>
      </div>
      <div class="card">
        <div class="card-title">Timing</div>
        <div class="form-row"><label>Grace period (minutes)</label><input type="number" name="graceMinutes" value="${cfg.graceMinutes ?? 2}" min="0" max="60"></div>
        <div class="form-row"><label>Warning period (minutes)</label><input type="number" name="warningMinutes" value="${cfg.warningMinutes ?? 3}" min="0" max="60"></div>
      </div>
      <div class="card">
        <div class="card-title">Monitored Voice Channels</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.5rem;">
          ${channels.map(c => `<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem;cursor:pointer;"><input type="checkbox" name="monitoredChannels" value="${c.id}" ${monitored.includes(c.id) ? 'checked' : ''}> ${c.name}</label>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Exempt Roles</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.5rem;">
          ${roles.map(r => `<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem;cursor:pointer;"><input type="checkbox" name="exemptRoles" value="${r.id}" ${exempt.includes(r.id) ? 'checked' : ''}> ${r.name}</label>`).join('')}
        </div>
      </div>
      <button type="submit" class="btn btn-primary">💾 Save Changes</button>
    </form>`;
  res.send(renderLayout({ title: 'Camera Policy', guildId, currentPath: '/camera', allowedGuildIds, username: req.session.userTag, body }));
});

app.post('/camera/save', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const cfg = loadCameraConfig();
  if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId].enabled = req.body.enabled === 'on';
  cfg[guildId].graceMinutes = parseInt(req.body.graceMinutes) || 2;
  cfg[guildId].warningMinutes = parseInt(req.body.warningMinutes) || 3;
  const mc = req.body.monitoredChannels;
  cfg[guildId].monitoredChannels = mc ? (Array.isArray(mc) ? mc : [mc]) : [];
  const er = req.body.exemptRoles;
  cfg[guildId].exemptRoleIds = er ? (Array.isArray(er) ? er : [er]) : [];
  saveCameraConfig(cfg);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('✅ Camera policy saved.')}`);
});

// ── channel index ──────────────────────────────────────────────────────────
app.get('/channel-index', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const flash = req.query.flash ? `<div class="flash flash-ok">${decodeURIComponent(req.query.flash)}</div>` : '';
  const body = `
    <div class="page-title">CHANNEL INDEX</div>
    <div class="page-sub">Post a formatted channel index embed to Discord.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Actions</div>
      <form method="POST" action="/channel-index/post?guild=${guildId}" style="display:flex;gap:.75rem;flex-wrap:wrap;">
        <button type="submit" class="btn btn-primary">📋 Post Channel Index</button>
      </form>
    </div>`;
  res.send(renderLayout({ title: 'Channel Index', guildId, currentPath: '/channel-index', allowedGuildIds, username: req.session.userTag, body }));
});

app.post('/channel-index/post', async (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  try {
    const guild = await client.guilds.fetch(guildId);
    await exportToFile(guild);
    res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('✅ Channel index posted.')}`);
  } catch (err) {
    res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('❌ Error: ' + err.message)}`);
  }
});

// ── speed match ────────────────────────────────────────────────────────────
app.get('/speed-match', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const cfg = (loadVcShuffleConfig()[guildId]) || {};
  const flash = req.query.flash ? `<div class="flash flash-ok">${decodeURIComponent(req.query.flash)}</div>` : '';
  const body = `
    <div class="page-title">SPEED MATCH</div>
    <div class="page-sub">Manage speed matching events. Use Discord slash commands to start/stop.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Current Status</div>
      <table>
        <tr><td>Session</td><td><span class="status-dot ${cfg.running ? 'status-on' : 'status-off'}"></span>${cfg.running ? 'Running' : 'Idle'}</td></tr>
        <tr><td>Connection Mode</td><td>${cfg.connectionMode || 'standard'}</td></tr>
        <tr><td>Round Duration</td><td>${cfg.roundMinutes || 5} minutes</td></tr>
        <tr><td>Cloud Rooms</td><td>${cfg.cloudRoomIds?.length || 0} configured</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-title">Slash Commands</div>
      <div style="color:var(--muted);font-size:.85rem;line-height:2;">
        <code style="color:var(--magenta)">/speed-match start</code> — Start a session<br>
        <code style="color:var(--magenta)">/speed-match stop</code> — Stop the session<br>
        <code style="color:var(--magenta)">/speed-match status</code> — Check session status<br>
        <code style="color:var(--magenta)">/speed-match shuffle-now</code> — Force a shuffle<br>
        <code style="color:var(--magenta)">/speed-match end-session</code> — End and post summary
      </div>
    </div>`;
  res.send(renderLayout({ title: 'Speed Match', guildId, currentPath: '/speed-match', allowedGuildIds, username: req.session.userTag, body }));
});

// ── sticky posts ───────────────────────────────────────────────────────────
const STICKY_FILE = dataPath('sticky-posts.json');
function loadSticky() { try { return JSON.parse(fs.readFileSync(STICKY_FILE, 'utf-8')); } catch { return {}; } }
function saveSticky(d) { fs.writeFileSync(STICKY_FILE, JSON.stringify(d, null, 2)); }

// In-memory: last sticky message per channel
const stickyLastMsg = {};

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const sticky = loadSticky();
  const gSticky = sticky[msg.guildId];
  if (!gSticky) return;
  const entry = gSticky[msg.channelId];
  if (!entry?.content) return;
  try {
    if (stickyLastMsg[msg.channelId]) {
      const old = await msg.channel.messages.fetch(stickyLastMsg[msg.channelId]).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
    const sent = await msg.channel.send({ content: `📌 ${entry.content}` });
    stickyLastMsg[msg.channelId] = sent.id;
  } catch {}
});

app.get('/sticky', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const sticky = loadSticky();
  const gSticky = sticky[guildId] || {};
  const flash = req.query.flash ? `<div class="flash flash-ok">${decodeURIComponent(req.query.flash)}</div>` : '';
  const channels = guild ? [...guild.channels.cache.values()].filter(c =>
    c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice ||
    c.type === ChannelType.PublicThread || c.type === ChannelType.GuildForum
  ).sort((a,b) => a.name.localeCompare(b.name)) : [];

  const existingRows = Object.entries(gSticky).map(([chId, entry]) => {
    const ch = guild?.channels.cache.get(chId);
    return `<tr>
      <td>#${ch?.name || chId}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.content}</td>
      <td><form method="POST" action="/sticky/delete?guild=${guildId}"><input type="hidden" name="channelId" value="${chId}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">Remove</button></form></td>
    </tr>`;
  }).join('');

  const body = `
    <div class="page-title">STICKY POSTS</div>
    <div class="page-sub">Messages that re-post themselves at the bottom of a channel whenever someone else sends a message.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Add Sticky Post</div>
      <form method="POST" action="/sticky/save?guild=${guildId}">
        <div class="form-row"><label>Channel</label>
          <select name="channelId"><option value="">— select channel —</option>
            ${channels.map(c => `<option value="${c.id}">${c.type === ChannelType.GuildVoice ? '🔊' : '#'} ${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Message content</label><textarea name="content" placeholder="Enter your sticky message..." rows="4"></textarea></div>
        <button type="submit" class="btn btn-primary">📌 Set Sticky</button>
      </form>
    </div>
    ${existingRows ? `<div class="card"><div class="card-title">Active Sticky Posts</div><table><thead><tr><th>Channel</th><th>Message</th><th></th></tr></thead><tbody>${existingRows}</tbody></table></div>` : ''}`;
  res.send(renderLayout({ title: 'Sticky Posts', guildId, currentPath: '/sticky', allowedGuildIds, username: req.session.userTag, body }));
});

app.post('/sticky/save', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const { channelId, content } = req.body;
  if (!channelId || !content?.trim()) return res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('❌ Channel and message are required.')}`);
  const sticky = loadSticky();
  if (!sticky[guildId]) sticky[guildId] = {};
  sticky[guildId][channelId] = { content: content.trim() };
  saveSticky(sticky);
  res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post saved.')}`);
});

app.post('/sticky/delete', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const { channelId } = req.body;
  const sticky = loadSticky();
  if (sticky[guildId]) delete sticky[guildId][channelId];
  saveSticky(sticky);
  res.redirect(`/sticky?guild=${guildId}&flash=${encodeURIComponent('✅ Sticky post removed.')}`);
});

// ── auto responders ────────────────────────────────────────────────────────
const AR_FILE = dataPath('autoresponders.json');
function loadAR() { try { return JSON.parse(fs.readFileSync(AR_FILE, 'utf-8')); } catch { return {}; } }
function saveAR(d) { fs.writeFileSync(AR_FILE, JSON.stringify(d, null, 2)); }

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guildId) return;
  const ar = loadAR();
  const gAR = ar[msg.guildId];
  if (!gAR?.length) return;
  const lower = msg.content.toLowerCase();
  for (const rule of gAR) {
    const match = rule.matchType === 'exact'
      ? lower === rule.trigger.toLowerCase()
      : lower.includes(rule.trigger.toLowerCase());
    if (match) {
      await msg.channel.send(rule.response).catch(() => {});
      break;
    }
  }
});

app.get('/autoresponder', (req, res) => {
  const guildId = resolveGuildId(req);
  const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.redirect('/');
  const ar = loadAR();
  const gAR = ar[guildId] || [];
  const flash = req.query.flash ? `<div class="flash flash-ok">${decodeURIComponent(req.query.flash)}</div>` : '';
  const rows = gAR.map((rule, i) => `<tr>
    <td><code>${rule.trigger}</code></td>
    <td>${rule.matchType}</td>
    <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${rule.response}</td>
    <td><form method="POST" action="/autoresponder/delete?guild=${guildId}"><input type="hidden" name="index" value="${i}"><button type="submit" class="btn btn-danger" style="padding:.25rem .6rem;font-size:.75rem;">Remove</button></form></td>
  </tr>`).join('');
  const body = `
    <div class="page-title">AUTO RESPONDERS</div>
    <div class="page-sub">Bot replies automatically when a trigger word or phrase is detected.</div>
    ${flash}
    <div class="card">
      <div class="card-title">Add Auto Responder</div>
      <form method="POST" action="/autoresponder/save?guild=${guildId}">
        <div class="form-row"><label>Trigger phrase</label><input type="text" name="trigger" placeholder="e.g. !rules or when does the event start"></div>
        <div class="form-row"><label>Match type</label>
          <select name="matchType">
            <option value="contains">Contains (trigger appears anywhere in message)</option>
            <option value="exact">Exact match only</option>
          </select>
        </div>
        <div class="form-row"><label>Response</label><textarea name="response" placeholder="Bot's reply..." rows="3"></textarea></div>
        <button type="submit" class="btn btn-primary">➕ Add Responder</button>
      </form>
    </div>
    ${rows ? `<div class="card"><div class="card-title">Active Responders</div><table><thead><tr><th>Trigger</th><th>Match</th><th>Response</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  res.send(renderLayout({ title: 'Auto Responders', guildId, currentPath: '/autoresponder', allowedGuildIds, username: req.session.userTag, body }));
});

app.post('/autoresponder/save', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const { trigger, matchType, response } = req.body;
  if (!trigger?.trim() || !response?.trim()) return res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('❌ Trigger and response are required.')}`);
  const ar = loadAR();
  if (!ar[guildId]) ar[guildId] = [];
  ar[guildId].push({ trigger: trigger.trim(), matchType: matchType || 'contains', response: response.trim() });
  saveAR(ar);
  res.redirect(`/autoresponder?guild=${guildId}&flash=${encodeURIComponent('✅ Auto responder added.')}`);
});

app.post('/autoresponder/delete', (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) return res.redirect('/');
  const idx = parseInt(req.body.index);
  const ar = loadAR();
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
