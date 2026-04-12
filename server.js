const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');

// Подключение к твоей базе Supabase
const SUPABASE_URL = 'https://zagvyrqnayxdbqkcjqud.supabase.co';
const SUPABASE_KEY = 'sb_publishable_glnqsWdFcmaHOzUrfD5fGA_dt6xiB1f';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Настройка ввода из консоли
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let localGiftersData = {}; // Локальный кэш для скорости

// Запрашиваем юзернейм при запуске
rl.question('Введите username TikTok стримера (без @): ', (streamerUsername) => {
    streamerUsername = streamerUsername.trim();
    if (!streamerUsername) {
        console.log('Юзернейм не может быть пустым!');
        process.exit(1);
    }
    startMonitoring(streamerUsername);
});

async function startMonitoring(streamerUsername) {
    console.log(`\n⏳ Подключение к стриму @${streamerUsername}...`);
    const tiktokLiveConnection = new WebcastPushConnection(streamerUsername);

    try {
        await tiktokLiveConnection.connect();
        console.log(`✅ Успешно подключено к стриму @${streamerUsername}`);
        console.log(`📡 Ожидание подарков (виджет в OBS уже будет обновляться)...\n`);

        tiktokLiveConnection.on('gift', async data => {
            // Если это комбо-подарок (розочка х10), считаем только когда комбо закончилось
            if (data.giftType === 1 && !data.repeatEnd) {
                return;
            }

            const gifter = data.uniqueId;
            const nickname = data.nickname;
            const avatar = data.profilePictureUrl;
            const coins = data.diamondCount * data.repeatCount;

            // Регистрируем дарителя, если он первый раз
            if (!localGiftersData[gifter]) {
                localGiftersData[gifter] = {
                    streamer_username: streamerUsername,
                    gifter_username: gifter,
                    gifter_nickname: nickname,
                    avatar_url: avatar,
                    coins: 0
                };
            }

            // Добавляем новые монеты
            localGiftersData[gifter].coins += coins;
            localGiftersData[gifter].updated_at = new Date().toISOString();

            console.log(`🎁 ${nickname} отправил(а) подарков на ${coins} монет! (Всего за стрим: ${localGiftersData[gifter].coins})`);

            // Отправляем в Supabase
            const { error } = await supabase
                .from('top_gifters')
                .upsert(localGiftersData[gifter], { onConflict: 'streamer_username, gifter_username' });

            if (error) {
                console.error("❌ Ошибка записи в БД:", error.message);
            }
        });

        tiktokLiveConnection.on('disconnected', () => {
            console.log('\n⚠️ Стрим завершен или связь прервана.');
            process.exit(0);
        });

    } catch (err) {
        console.error(`\n❌ Ошибка подключения:`, err.message);
        process.exit(1);
    }
}
