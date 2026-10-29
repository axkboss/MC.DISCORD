'use strict';

const { Pool } = require('pg');
const mineflayer = require('mineflayer');
const {
    ActivityType,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    PermissionFlagsBits
} = require('discord.js');
const util = require('minecraft-server-util');

const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;

const JAVA_IP = process.env.JAVA_IP || 'beast.roviotech.bond';
const JAVA_PORT = Number(process.env.JAVA_PORT || 19138);
const PE_IP = process.env.PE_IP || JAVA_IP;
const PE_PORT = Number(process.env.PE_PORT || 19138);
const BOT_USERNAME = process.env.BOT_USERNAME || 'ShineMC_Bot';

function validateConfig() {
    const missing = [
        ['DISCORD_TOKEN', TOKEN],
        ['DATABASE_URL', DATABASE_URL],
        ['STATUS_CHANNEL_ID', STATUS_CHANNEL_ID],
        ['CHAT_CHANNEL_ID', CHAT_CHANNEL_ID]
    ].filter(([, value]) => !value || value.startsWith('YOUR_')).map(([name]) => name);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    for (const [name, value] of [['STATUS_CHANNEL_ID', STATUS_CHANNEL_ID], ['CHAT_CHANNEL_ID', CHAT_CHANNEL_ID]]) {
        if (!/^\d{17,20}$/.test(value)) {
            throw new Error(`${name} must be a Discord channel ID.`);
        }
    }

    if (!Number.isInteger(JAVA_PORT) || JAVA_PORT < 1 || JAVA_PORT > 65535
        || !Number.isInteger(PE_PORT) || PE_PORT < 1 || PE_PORT > 65535) {
        throw new Error('JAVA_PORT and PE_PORT must be valid port numbers.');
    }
}

validateConfig();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const databaseUrl = DATABASE_URL || '';
const shouldUseSsl = Boolean(databaseUrl)
    && !databaseUrl.includes('localhost')
    && !databaseUrl.includes('127.0.0.1');
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl ? { rejectUnauthorized: true } : false
});

const defaultData = {
    top_kills: {
        Friendlyguy00069: 150,
        Sarivox: 120,
        VoidStark: 95
    },
    tiers: {
        HT1: ['Friendlyguy00069'],
        LT1: ['Sarivox'],
        HT2: ['VoidStark'],
        LT2: [],
        HT3: []
    }
};

let mcBot = null;
let statusMessage = null;
let statusInterval = null;
let reconnectTimeout = null;
let shuttingDown = false;

function freshDefaultData() {
    return {
        top_kills: { ...defaultData.top_kills },
        tiers: Object.fromEntries(
            Object.entries(defaultData.tiers).map(([tier, players]) => [tier, [...players]])
        )
    };
}

function normalizeData(value) {
    const data = freshDefaultData();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return data;

    if (value.top_kills && typeof value.top_kills === 'object' && !Array.isArray(value.top_kills)) {
        for (const [player, kills] of Object.entries(value.top_kills)) {
            if (Number.isSafeInteger(kills) && kills >= 0) data.top_kills[player] = kills;
        }
    }

    if (value.tiers && typeof value.tiers === 'object' && !Array.isArray(value.tiers)) {
        for (const [tier, players] of Object.entries(value.tiers)) {
            if (Array.isArray(players)) {
                data.tiers[tier] = players.filter(player => typeof player === 'string');
            }
        }
    }

    return data;
}

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS shinemc_store (
            id INT PRIMARY KEY,
            data JSONB NOT NULL
        )
    `);
    await pool.query(
        'INSERT INTO shinemc_store (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
        [JSON.stringify(defaultData)]
    );
    console.log('Connected to Neon PostgreSQL Database.');
}

async function loadData() {
    const result = await pool.query('SELECT data FROM shinemc_store WHERE id = 1');
    return normalizeData(result.rows[0]?.data);
}

async function saveData(data) {
    await pool.query(
        'UPDATE shinemc_store SET data = $1::jsonb WHERE id = 1',
        [JSON.stringify(data)]
    );
}

function getTextChannel(channelId) {
    const channel = client.channels.cache.get(channelId);
    return channel?.isTextBased() ? channel : null;
}

// ================= MINECRAFT CHAT BRIDGE =================
function startMinecraftBot() {
    if (shuttingDown) return;

    try {
        mcBot = mineflayer.createBot({
            host: JAVA_IP,
            port: JAVA_PORT,
            username: BOT_USERNAME,
            version: false
        });
    } catch (error) {
        console.error('[MC Bot Error] Could not create bot:', error);
        reconnectTimeout = setTimeout(startMinecraftBot, 10_000);
        return;
    }

    mcBot.on('login', () => {
        console.log(`[MC Bot] Joined ${JAVA_IP}:${JAVA_PORT}`);
        const chatChannel = getTextChannel(CHAT_CHANNEL_ID);
        if (chatChannel) {
            chatChannel.send('✅ **Server has started | ShineMC Chat Bridge Online**')
                .catch(error => console.error('[Discord Chat Error]:', error.message));
        }
    });

    mcBot.on('messagestr', message => {
        const cleanMessage = message.trim();
        if (!cleanMessage || cleanMessage.includes('[Discord]')) return;

        const chatChannel = getTextChannel(CHAT_CHANNEL_ID);
        if (!chatChannel) return;

        if (cleanMessage.includes('has made the advancement')
            || cleanMessage.includes('has completed the challenge')) {
            const embed = new EmbedBuilder()
                .setDescription(`🏆 **${cleanMessage.slice(0, 4000)}**`)
                .setColor(0xFFA500);
            chatChannel.send({ embeds: [embed] })
                .catch(error => console.error('[Discord Chat Error]:', error.message));
            return;
        }

        const safeMessage = cleanMessage.replace(/@/g, '@\u200b').slice(0, 1900);
        chatChannel.send(`**${safeMessage}**`)
            .catch(error => console.error('[Discord Chat Error]:', error.message));
    });

    mcBot.on('end', () => {
        mcBot = null;
        if (!shuttingDown) reconnectTimeout = setTimeout(startMinecraftBot, 10_000);
    });

    mcBot.on('error', error => console.error(`[MC Bot Error]: ${error.message}`));
}

// ================= LIVE STATUS & LEADERBOARD =================
async function getOnlinePlayers() {
    try {
        const result = await util.status(JAVA_IP, JAVA_PORT, { timeout: 5000 });
        return `${result.players.online}/${result.players.max}`;
    } catch (javaError) {
        try {
            const result = await util.statusBedrock(PE_IP, PE_PORT, { timeout: 5000 });
            return `${result.players.online}/${result.players.max}`;
        } catch (bedrockError) {
            return '0 (Offline)';
        }
    }
}

async function buildBoardEmbed(data, onlinePlayers) {
    const [boardData, playerCount] = await Promise.all([
        data ? Promise.resolve(data) : loadData(),
        onlinePlayers ? Promise.resolve(onlinePlayers) : getOnlinePlayers()
    ]);

    const sortedKills = Object.entries(boardData.top_kills)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    const killsText = sortedKills.length > 0
        ? sortedKills.map(([name, kills], index) => `\`#${index + 1}\` **${name}** — \`${kills} Kills\``).join('\n')
        : 'No kills recorded yet.';

    const tierText = Object.entries(boardData.tiers)
        .map(([tier, players]) => `🏆 **${tier}:** ${players.length > 0 ? players.join(', ') : 'None'}`)
        .join('\n') || 'No tiers recorded yet.';

    return new EmbedBuilder()
        .setTitle('⚔️ ShineMC - Official PvP Server')
        .setDescription(
            '**shinemc is best minecraft pvp server**\n'
            + '🟢 **24/7 uptime**\n'
            + '📶 **Ping is so good**\n'
            + '⚡ **Tps is 20**\n\n'
            + `👥 **ONLINE PLAYER :** \`${playerCount}\`\n\n`
            + `💻 **Java IP:** \`${JAVA_IP}:${JAVA_PORT}\`\n`
            + `📱 **PE IP:** \`${PE_IP}\` | **Port:** \`${PE_PORT}\``
        )
        .addFields(
            { name: '🔥 Top 10 Kills Leaderboard', value: killsText, inline: false },
            { name: '👑 ShineMC PvP Tier List', value: tierText.slice(0, 1024) || 'None', inline: false }
        )
        .setColor(0x00FF80)
        .setFooter({ text: 'ShineMC Bot • Powered by Neon PostgreSQL' })
        .setTimestamp();
}

async function updateStatusBoard() {
    const onlinePlayers = await getOnlinePlayers();
    if (client.user) {
        client.user.setActivity(`ShineMC | ${onlinePlayers} Players`, { type: ActivityType.Playing });
    }

    const channel = getTextChannel(STATUS_CHANNEL_ID);
    if (!channel) {
        console.error(`Status channel ${STATUS_CHANNEL_ID} was not found or is not text-based.`);
        return;
    }

    const embed = await buildBoardEmbed(undefined, onlinePlayers);
    try {
        if (!statusMessage) statusMessage = await channel.send({ embeds: [embed] });
        else await statusMessage.edit({ embeds: [embed] });
    } catch (error) {
        console.error('[Status Board Error]:', error.message);
        statusMessage = null;
    }
}

// ================= DISCORD EVENTS & COMMANDS =================
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    updateStatusBoard().catch(error => console.error('[Status Board Error]:', error));
    statusInterval = setInterval(() => {
        updateStatusBoard().catch(error => console.error('[Status Board Error]:', error));
    }, 60_000);
    startMinecraftBot();
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    try {
        if (message.channel.id === CHAT_CHANNEL_ID && !message.content.startsWith('!')) {
            if (mcBot?.entity) {
                const chatMessage = message.content.replace(/\s+/g, ' ').slice(0, 200);
                if (chatMessage) mcBot.chat(`[Discord] ${message.author.username}: ${chatMessage}`);
            } else {
                await message.react('❌');
            }
            return;
        }

        if (!message.content.startsWith('!')) return;
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift()?.toLowerCase();

        if (command === 'board' || command === 'status') {
            const embed = await buildBoardEmbed();
            await message.channel.send({ embeds: [embed] });
            return;
        }

        if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
        const data = await loadData();

        if (command === 'setkills') {
            const [player, killsText] = args;
            const kills = Number(killsText);
            if (!/^[A-Za-z0-9_]{1,16}$/.test(player || '')
                || !/^\d+$/.test(killsText || '')
                || !Number.isSafeInteger(kills)) {
                await message.reply('⚠️ Usage: `!setkills <PlayerName> <non-negative Kills>`');
                return;
            }

            data.top_kills[player] = kills;
            await saveData(data);
            await updateStatusBoard();
            await message.reply(`✅ **${player}** ke kills Neon DB mein save ho gaye: \`${kills} Kills\``);
            return;
        }

        if (command === 'removekills') {
            const player = args[0];
            if (!player || !(player in data.top_kills)) {
                await message.reply('❌ Player nahi mila.');
                return;
            }

            delete data.top_kills[player];
            await saveData(data);
            await updateStatusBoard();
            await message.reply(`🗑️ **${player}** ko Top Kills se hata diya.`);
            return;
        }

        if (command === 'settier') {
            const tier = args[0]?.toUpperCase();
            const player = args[1];
            if (!tier || !/^[A-Z0-9]{1,10}$/.test(tier)
                || !/^[A-Za-z0-9_]{1,16}$/.test(player || '')) {
                await message.reply('⚠️ Usage: `!settier <Tier> <PlayerName>`');
                return;
            }

            if (!data.tiers[tier]) data.tiers[tier] = [];
            for (const existingTier of Object.keys(data.tiers)) {
                data.tiers[existingTier] = data.tiers[existingTier].filter(name => name !== player);
            }
            data.tiers[tier].push(player);
            await saveData(data);
            await updateStatusBoard();
            await message.reply(`👑 **${player}** ko **${tier}** tier mein save kar diya!`);
            return;
        }

        if (command === 'removetier') {
            const player = args[0];
            if (!/^[A-Za-z0-9_]{1,16}$/.test(player || '')) {
                await message.reply('⚠️ Usage: `!removetier <PlayerName>`');
                return;
            }

            for (const tier of Object.keys(data.tiers)) {
                data.tiers[tier] = data.tiers[tier].filter(name => name !== player);
            }
            await saveData(data);
            await updateStatusBoard();
            await message.reply(`🗑️ **${player}** ko Tier List se hata diya.`);
        }
    } catch (error) {
        console.error('[Discord Command Error]:', error);
        await message.reply('⚠️ Command failed. Check the bot logs for details.')
            .catch(replyError => console.error('[Discord Reply Error]:', replyError.message));
    }
});

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    clearInterval(statusInterval);
    clearTimeout(reconnectTimeout);
    if (mcBot) mcBot.quit();
    client.destroy();
    await pool.end();
}

process.once('SIGINT', () => {
    shutdown('SIGINT').catch(error => console.error('[Shutdown Error]:', error));
});
process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch(error => console.error('[Shutdown Error]:', error));
});

async function main() {
    await initDB();
    await client.login(TOKEN);
}

main().catch(async error => {
    console.error('[Startup Error]:', error);
    client.destroy();
    await pool.end();
    process.exitCode = 1;
});