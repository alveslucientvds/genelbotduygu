require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

/* =========================
   BASIC CONFIG
========================= */
const TOKEN = process.env.TOKEN;
const PREFIX = process.env.PREFIX || ".";
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || "";
const STATUS_TEXT = process.env.STATUS_TEXT || ".yardim | klasik bot";
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error("TOKEN .env içinde eksik.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

/* =========================
   KEEP ALIVE SERVER
========================= */
const app = express();

app.get("/", (req, res) => {
  res.status(200).send("Bot aktif.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    bot: client.user ? client.user.tag : "not-ready",
    uptimeSec: Math.floor(process.uptime())
  });
});

app.use((req, res) => {
  res.status(200).send("Bot aktif.");
});

app.listen(PORT, () => {
  console.log(`Web server aktif: ${PORT}`);
});

/* =========================
   CRASH GUARD
========================= */
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
  console.error("Uncaught Exception Monitor:", error);
});

/* =========================
   HELPERS
========================= */
function formatDuration(ms) {
  if (!ms || Number.isNaN(ms)) return "Bilinmiyor";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resolveTargetId(text) {
  if (!text) return null;
  const mentionMatch = text.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];

  const idMatch = text.match(/^(\d{17,20})$/);
  if (idMatch) return idMatch[1];

  return null;
}

async function resolveMember(message, argText) {
  const mention = message.mentions.members.first();
  if (mention) return mention;

  const targetId = resolveTargetId(argText);
  if (!targetId) return null;

  try {
    return await message.guild.members.fetch(targetId);
  } catch {
    return null;
  }
}

async function ensureSpecialRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === "Special");

  if (!role) {
    role = await guild.roles.create({
      name: "Special",
      reason: "VIP komutu için otomatik oluşturuldu"
    });
  }

  return role;
}

async function safeAutoJoinVoice() {
  try {
    if (!VOICE_CHANNEL_ID) return;

    const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.log("Auto join iptal: ses kanalı bulunamadı.");
      return;
    }

    if (
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice
    ) {
      console.log("VOICE_CHANNEL_ID bir ses kanalı değil.");
      return;
    }

    const guild = channel.guild;
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) return;

    const perms = channel.permissionsFor(me);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.Connect) ||
      !perms.has(PermissionsBitField.Flags.ViewChannel)
    ) {
      console.log("Botun ses kanalına girme izni yok.");
      return;
    }

    const existing = getVoiceConnection(guild.id);
    if (existing && existing.joinConfig.channelId === channel.id) {
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log(`Ses kanalına bağlandı: ${channel.name}`);
    } catch (err) {
      console.error("Voice ready hatası:", err);
      connection.destroy();
    }
  } catch (error) {
    console.error("safeAutoJoinVoice hatası:", error);
  }
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`${client.user.tag} olarak giriş yapıldı.`);

  client.user.setPresence({
    activities: [
      {
        name: STATUS_TEXT,
        type: 0
      }
    ],
    status: "idle"
  });

  await safeAutoJoinVoice();
});

/* =========================
   VOICE RE-JOIN
========================= */
client.on("voiceStateUpdate", async () => {
  if (!VOICE_CHANNEL_ID || !client.user) return;

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.guild) return;

  const connection = getVoiceConnection(channel.guild.id);

  if (!connection) {
    await safeAutoJoinVoice();
    return;
  }

  const currentChannelId = connection.joinConfig.channelId;
  if (currentChannelId !== VOICE_CHANNEL_ID) {
    try {
      connection.destroy();
    } catch {}
    await safeAutoJoinVoice();
  }
});

/* =========================
   COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (!message.content.toLowerCase().startsWith(PREFIX.toLowerCase())) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (args.shift() || "").toLowerCase();
    const restText = args.join(" ");

    /* =========================
       .yardim
    ========================= */
    if (command === "yardim" || command === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle("Komutlar")
        .setDescription(
          [
            `\`${PREFIX}av\` → Kendi avatarını gösterir`,
            `\`${PREFIX}av @user\` → Etiketlenen kişinin avatarını gösterir`,
            `\`${PREFIX}spotify\` / \`${PREFIX}spo\` → Kendi Spotify bilgisini gösterir`,
            `\`${PREFIX}spotify @user\` / \`${PREFIX}spo @user\` → Başkasının Spotify bilgisini gösterir`,
            `\`${PREFIX}vip @user\` veya \`${PREFIX}vip ID\` → Special rolü verir`,
            `\`${PREFIX}nuke\` → Bulunduğun kanalı silip aynı izinlerle tekrar açar`
          ].join("\n")
        )
        .setFooter({ text: `${message.guild.name}` });

      return message.reply({ embeds: [embed] });
    }

    /* =========================
       .av
    ========================= */
    if (command === "av") {
      const member = (await resolveMember(message, restText)) || message.member;
      const avatarURL = member.user.displayAvatarURL({ size: 4096, extension: "png" });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${member.user.tag} avatarı`)
        .setImage(avatarURL)
        .setDescription(`[Tarayıcıda aç](${avatarURL})`);

      return message.reply({ embeds: [embed] });
    }

    /* =========================
       .spotify / .spo
    ========================= */
    if (command === "spotify" || command === "spo") {
      const member = (await resolveMember(message, restText)) || message.member;

      if (!member.presence) {
        return message.reply(
          "Bu kullanıcının presence bilgisi görünmüyor. Developer Portal'da Presence Intent açık olmalı ve kullanıcı durumu görünür olmalı."
        );
      }

      const spotifyActivity = member.presence.activities.find(
        (activity) => activity.name === "Spotify"
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

      let spotifyUrl = null;
      if (spotifyActivity.syncId) {
        spotifyUrl = `https://open.spotify.com/track/${spotifyActivity.syncId}`;
      }

      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setAuthor({
          name: `${member.user.tag} Spotify dinliyor`
        })
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
        .setFooter({ text: "Spotify" });

      if (cover) embed.setThumbnail(cover);
      if (spotifyUrl) embed.setDescription(`[Spotify'da aç](${spotifyUrl})`);

      return message.reply({ embeds: [embed] });
    }

    /* =========================
       .vip
    ========================= */
    if (command === "vip") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply("Bu komut için `Rolleri Yönet` yetkisine sahip olmalısın.");
      }

      const targetMember = await resolveMember(message, restText);
      if (!targetMember) {
        return message.reply("Bir kullanıcı etiketle veya geçerli bir kullanıcı ID'si yaz.");
      }

      const specialRole = await ensureSpecialRole(message.guild);

      const me = message.guild.members.me || (await message.guild.members.fetchMe());
      if (specialRole.position >= me.roles.highest.position) {
        return message.reply(
          "Special rolü benim en yüksek rolümden yukarıda olduğu için veremiyorum. Bot rolünü daha üste taşı."
        );
      }

      if (targetMember.roles.cache.has(specialRole.id)) {
        return message.reply(`${targetMember.user.tag} zaten Special rolüne sahip.`);
      }

      await targetMember.roles.add(specialRole, `${message.author.tag} tarafından VIP verildi`);

      return message.reply(
        `✅ ${targetMember.user.tag} kullanıcısına \`${specialRole.name}\` rolü verildi.`
      );
    }

    /* =========================
       .nuke
    ========================= */
    if (command === "nuke") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return message.reply("Bu komut için `Kanalları Yönet` yetkisine sahip olmalısın.");
      }

      const channel = message.channel;
      if (!channel || typeof channel.clone !== "function") {
        return message.reply("Bu kanal türü nuke için uygun değil.");
      }

      const oldPosition = channel.rawPosition;
      const oldParentId = channel.parentId;
      const oldName = channel.name;

      const cloned = await channel.clone({
        name: oldName,
        reason: `${message.author.tag} tarafından nuke komutu kullanıldı`
      });

      if (oldParentId) {
        await cloned.setParent(oldParentId, { lockPermissions: false }).catch(() => null);
      }

      await cloned.setPosition(oldPosition).catch(() => null);

      await channel.delete(`${message.author.tag} tarafından nuke komutu kullanıldı`);

      await cloned.setPosition(oldPosition).catch(() => null);

      try {
        await cloned.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff3b30)
              .setTitle("💥 Kanal Nukelendi")
              .setDescription(`Bu kanal ${message.author} tarafından yenilendi.`)
          ]
        });
      } catch {}

      return;
    }
  } catch (error) {
    console.error("Komut hatası:", error);

    try {
      await message.reply("Komut çalışırken bir hata oluştu.");
    } catch {}
  }
});

/* =========================
   LOGIN
========================= */
client.login(TOKEN);