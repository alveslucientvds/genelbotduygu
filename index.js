require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  ActivityType
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

/* =================================
   ENV
================================= */
const TOKEN = process.env.TOKEN;
const PREFIX = process.env.PREFIX || ".";
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || "";
const STATUS_TEXT = process.env.STATUS_TEXT || ".yardim | klasik bot";
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
  console.error("[FATAL] TOKEN bulunamadı.");
  process.exit(1);
}

/* =================================
   EXPRESS KEEPALIVE
================================= */
const app = express();

app.get("/", (req, res) => {
  res.status(200).send("Bot aktif");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    bot: client?.user?.tag || null,
    uptime: process.uptime(),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`[WEB] Server ${PORT} portunda aktif.`);
});

/* =================================
   CLIENT
================================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

/* =================================
   GLOBAL SAFETY
================================= */
let voiceReconnectLock = false;
let voiceReconnectTimeout = null;
let trackedVoiceGuildId = null;

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
  console.error("[uncaughtExceptionMonitor]", error);
});

process.on("SIGTERM", async () => {
  console.log("[SIGTERM] Kapatılıyor...");
  try {
    for (const guild of client.guilds.cache.values()) {
      const conn = getVoiceConnection(guild.id);
      if (conn) conn.destroy();
    }
    client.destroy();
  } catch (err) {
    console.error("[SIGTERM destroy error]", err);
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  console.log("[SIGINT] Kapatılıyor...");
  try {
    for (const guild of client.guilds.cache.values()) {
      const conn = getVoiceConnection(guild.id);
      if (conn) conn.destroy();
    }
    client.destroy();
  } catch (err) {
    console.error("[SIGINT destroy error]", err);
  } finally {
    process.exit(0);
  }
});

client.on("error", (err) => {
  console.error("[client error]", err);
});

client.on("warn", (info) => {
  console.warn("[client warn]", info);
});

client.on("shardError", (err) => {
  console.error("[shard error]", err);
});

/* =================================
   HELPERS
================================= */
function formatDuration(ms) {
  if (!ms || Number.isNaN(ms) || ms < 0) return "Bilinmiyor";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseUserId(input) {
  if (!input) return null;

  const mention = input.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];

  const rawId = input.match(/^(\d{17,20})$/);
  if (rawId) return rawId[1];

  return null;
}

async function resolveMember(message, text) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;

  const id = parseUserId(text);
  if (!id) return null;

  try {
    return await message.guild.members.fetch(id);
  } catch {
    return null;
  }
}

async function getOrCreateSpecialRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === "Special");

  if (!role) {
    role = await guild.roles.create({
      name: "Special",
      reason: "VIP komutu için otomatik oluşturuldu"
    });
  }

  return role;
}

async function getTargetVoiceChannel() {
  if (!VOICE_CHANNEL_ID) return null;

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel) return null;

  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    return null;
  }

  return channel;
}

function clearReconnectTimer() {
  if (voiceReconnectTimeout) {
    clearTimeout(voiceReconnectTimeout);
    voiceReconnectTimeout = null;
  }
}

async function connectToConfiguredVoice() {
  if (voiceReconnectLock) return null;

  voiceReconnectLock = true;

  try {
    const channel = await getTargetVoiceChannel();
    if (!channel) {
      console.log("[VOICE] Hedef ses kanalı bulunamadı veya geçersiz.");
      return null;
    }

    const guild = channel.guild;
    trackedVoiceGuildId = guild.id;

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) {
      console.log("[VOICE] Bot member bilgisi alınamadı.");
      return null;
    }

    const perms = channel.permissionsFor(me);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms.has(PermissionsBitField.Flags.Connect)
    ) {
      console.log("[VOICE] Ses kanalına bağlanma yetkisi yok.");
      return null;
    }

    const existing = getVoiceConnection(guild.id);

    if (existing) {
      const currentChannelId = existing.joinConfig?.channelId;
      const state = existing.state?.status;

      if (
        currentChannelId === channel.id &&
        state !== VoiceConnectionStatus.Destroyed &&
        state !== VoiceConnectionStatus.Disconnected
      ) {
        return existing;
      }

      try {
        existing.destroy();
      } catch (err) {
        console.error("[VOICE] Eski bağlantı silinirken hata:", err);
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log(`[VOICE] ${oldState.status} -> ${newState.status}`);

      if (
        newState.status === VoiceConnectionStatus.Disconnected ||
        newState.status === VoiceConnectionStatus.Destroyed
      ) {
        scheduleVoiceReconnect();
      }
    });

    connection.on("error", (err) => {
      console.error("[VOICE connection error]", err);
      scheduleVoiceReconnect();
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`[VOICE] Bağlandı: ${channel.name}`);

    clearReconnectTimer();
    return connection;
  } catch (err) {
    console.error("[VOICE] Bağlanırken hata:", err);
    scheduleVoiceReconnect();
    return null;
  } finally {
    voiceReconnectLock = false;
  }
}

function scheduleVoiceReconnect(delay = 10_000) {
  if (!VOICE_CHANNEL_ID) return;
  if (voiceReconnectTimeout) return;

  voiceReconnectTimeout = setTimeout(async () => {
    voiceReconnectTimeout = null;
    await connectToConfiguredVoice();
  }, delay);
}

async function voiceWatchdog() {
  try {
    if (!VOICE_CHANNEL_ID || !trackedVoiceGuildId) return;

    const channel = await getTargetVoiceChannel();
    if (!channel) return;

    const conn = getVoiceConnection(trackedVoiceGuildId);

    if (!conn) {
      console.log("[VOICE WATCHDOG] Connection yok, tekrar bağlanılıyor.");
      await connectToConfiguredVoice();
      return;
    }

    const currentChannelId = conn.joinConfig?.channelId;
    const state = conn.state?.status;

    if (
      currentChannelId !== channel.id ||
      state === VoiceConnectionStatus.Destroyed ||
      state === VoiceConnectionStatus.Disconnected
    ) {
      console.log("[VOICE WATCHDOG] Connection bozuk, tekrar bağlanılıyor.");
      try {
        conn.destroy();
      } catch {}
      await connectToConfiguredVoice();
    }
  } catch (err) {
    console.error("[VOICE WATCHDOG ERROR]", err);
  }
}

/* =================================
   READY
================================= */
client.once("clientReady", async () => {
  console.log(`[READY] ${client.user.tag} giriş yaptı.`);

  try {
    client.user.setPresence({
      status: "idle",
      activities: [
        {
          name: STATUS_TEXT,
          type: ActivityType.Watching
        }
      ]
    });
  } catch (err) {
    console.error("[PRESENCE ERROR]", err);
  }

  await connectToConfiguredVoice();
});

/* =================================
   VOICE WATCHDOG
================================= */
setInterval(async () => {
  await voiceWatchdog();
}, 120_000);

/* =================================
   COMMANDS
================================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (args.shift() || "").toLowerCase();
    const restText = args.join(" ");

    if (!command) return;

    if (command === "yardim" || command === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle("Komutlar")
        .setDescription([
          `\`${PREFIX}av\` → Kendi avatarını gösterir`,
          `\`${PREFIX}av @user\` → Etiketlenen kişinin avatarını gösterir`,
          `\`${PREFIX}spotify\` / \`${PREFIX}spo\` → Spotify bilgisi`,
          `\`${PREFIX}spotify @user\` → Etiketlenen kişinin Spotify bilgisi`,
          `\`${PREFIX}vip @user\` veya \`${PREFIX}vip ID\` → Special rolü verir`,
          `\`${PREFIX}nuke\` → Bulunduğun kanalı sıfırlar`
        ].join("\n"))
        .setFooter({ text: `${message.guild.name}` });

      return message.reply({ embeds: [embed] });
    }

    if (command === "av") {
      const member = (await resolveMember(message, restText)) || message.member;
      const avatar = member.user.displayAvatarURL({
        size: 4096,
        extension: "png"
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${member.user.tag} avatarı`)
        .setImage(avatar)
        .setDescription(`[Tarayıcıda aç](${avatar})`);

      return message.reply({ embeds: [embed] });
    }

    if (command === "spotify" || command === "spo") {
      const member = (await resolveMember(message, restText)) || message.member;

      if (!member.presence) {
        return message.reply(
          "Presence bilgisi görünmüyor. Developer Portal'da Presence Intent açık olmalı."
        );
      }

      const spotifyActivity = member.presence.activities.find(
        (a) => a.name === "Spotify"
      );

      if (!spotifyActivity) {
        return message.reply("Bu kullanıcı şu an Spotify dinlemiyor.");
      }

      const track = spotifyActivity.details || "Bilinmiyor";
      const artist = spotifyActivity.state || "Bilinmiyor";
      const album = spotifyActivity.assets?.largeText || "Bilinmiyor";
      const cover = spotifyActivity.assets?.largeImageURL?.() || null;

      const startedAt = spotifyActivity.timestamps?.start?.getTime?.() || null;
      const endsAt = spotifyActivity.timestamps?.end?.getTime?.() || null;

      const elapsed = startedAt ? Date.now() - startedAt : null;
      const total = startedAt && endsAt ? endsAt - startedAt : null;

      const spotifyUrl = spotifyActivity.syncId
        ? `https://open.spotify.com/track/${spotifyActivity.syncId}`
        : null;

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setAuthor({ name: `${member.user.tag} Spotify dinliyor` })
        .addFields(
          { name: "Şarkı", value: track, inline: false },
          { name: "Sanatçı", value: artist, inline: false },
          { name: "Albüm", value: album, inline: false },
          {
            name: "Süre",
            value: `${formatDuration(elapsed)} / ${formatDuration(total)}`,
            inline: false
          }
        )
        .setFooter({ text: "Spotify Activity" });

      if (cover) embed.setThumbnail(cover);
      if (spotifyUrl) embed.setDescription(`[Spotify'da aç](${spotifyUrl})`);

      return message.reply({ embeds: [embed] });
    }

    if (command === "vip") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply("Bu komutu kullanmak için `Rolleri Yönet` yetkin olmalı.");
      }

      const targetMember = await resolveMember(message, restText);
      if (!targetMember) {
        return message.reply("Bir kullanıcı etiketle veya geçerli bir ID yaz.");
      }

      const role = await getOrCreateSpecialRole(message.guild);
      const me = message.guild.members.me || await message.guild.members.fetchMe();

      if (role.position >= me.roles.highest.position) {
        return message.reply(
          "Special rolü botun en yüksek rolünden yukarıda. Bot rolünü üste taşı."
        );
      }

      if (targetMember.roles.cache.has(role.id)) {
        return message.reply("Bu kullanıcıda zaten Special rolü var.");
      }

      await targetMember.roles.add(role, `${message.author.tag} tarafından VIP verildi`);

      return message.reply(`✅ ${targetMember.user.tag} kullanıcısına Special rolü verildi.`);
    }

    if (command === "nuke") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return message.reply("Bu komutu kullanmak için `Kanalları Yönet` yetkin olmalı.");
      }

      const oldChannel = message.channel;
      if (!oldChannel || typeof oldChannel.clone !== "function") {
        return message.reply("Bu kanal nuke için uygun değil.");
      }

      const oldPosition = oldChannel.rawPosition;
      const oldParentId = oldChannel.parentId;
      const oldName = oldChannel.name;

      const newChannel = await oldChannel.clone({
        name: oldName,
        reason: `${message.author.tag} tarafından nuke kullanıldı`
      });

      if (oldParentId) {
        await newChannel.setParent(oldParentId, { lockPermissions: false }).catch(() => null);
      }

      await newChannel.setPosition(oldPosition).catch(() => null);

      await oldChannel.delete(`${message.author.tag} tarafından nuke kullanıldı`);

      await newChannel.setPosition(oldPosition).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(0xFF3B30)
        .setTitle("💥 Kanal Nukelendi")
        .setDescription(`Bu kanal ${message.author} tarafından yenilendi.`);

      try {
        await newChannel.send({ embeds: [embed] });
      } catch {}

      return;
    }
  } catch (error) {
    console.error("[COMMAND ERROR]", error);
    try {
      await message.reply("Komut çalışırken bir hata oluştu.");
    } catch {}
  }
});

/* =================================
   LOGIN
================================= */
client.login(TOKEN);
