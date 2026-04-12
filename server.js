const express = require('express');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');

// Настраиваем веб-сервер Express (то, что ждет Railway)
const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Supabase
const SUPABASE_URL = 'https://zagvyrqnayxdbqkcjqud.supabase.co';
const SUPABASE_KEY = 'sb_publishable_glnqsWdFcmaHOzUrfD5fGA_dt6xiB1f';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Хранилище активных мониторингов, чтобы не запускать дубликаты
const activeMonitors = {};

// Главный маршрут: отдаем виджет и запускаем сборщик
app.get('/', (req, res) => {
    const username = req.query.user || req.query.username;

    // Если в ссылке передан юзернейм и мы его еще не мониторим - запускаем фоновый процесс
    if (username && !activeMonitors[username]) {
        startMonitoring(username);
    }

    // Отправляем красивый HTML виджет в браузер (или OBS)
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запускаем сервер на порту, который выдаст Railway
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Web-сервер успешно запущен на порту ${PORT}`);
});

// Функция мониторинга TikTok (работает в фоне сервера Railway)
async function startMonitoring(streamerUsername) {
    if (activeMonitors[streamerUsername]) return;
    activeMonitors[streamerUsername] = true;
    let localGiftersData = {};

    console.log(`⏳ Подключение к стриму @${streamerUsername}...`);
    const tiktokLiveConnection = new WebcastPushConnection(streamerUsername);

    try {
        await tiktokLiveConnection.connect();
        console.log(`✅ Успешно подключено к @${streamerUsername}`);

        tiktokLiveConnection.on('gift', async data => {
            if (data.giftType === 1 && !data.repeatEnd) return; // Пропуск спам-комбо

            const gifter = data.uniqueId;
            const coins = data.diamondCount * data.repeatCount;

            if (!localGiftersData[gifter]) {
                localGiftersData[gifter] = {
                    streamer_username: streamerUsername,
                    gifter_username: gifter,
                    gifter_nickname: data.nickname,
                    avatar_url: data.profilePictureUrl,
                    coins: 0
                };
            }

            localGiftersData[gifter].coins += coins;
            localGiftersData[gifter].updated_at = new Date().toISOString();

            console.log(`🎁 ${data.nickname} отправил(а) ${coins} монет @${streamerUsername}`);

            // Запись в Supabase
            const { error } = await supabase
                .from('top_gifters')
                .upsert(localGiftersData[gifter], { onConflict: 'streamer_username, gifter_username' });

            if (error) console.error("❌ Ошибка записи в БД:", error.message);
        });

        tiktokLiveConnection.on('disconnected', () => {
            console.log(`⚠️ Стрим @${streamerUsername} завершен.`);
            delete activeMonitors[streamerUsername]; // Очищаем статус, чтобы можно было переподключиться
        });

    } catch (err) {
        console.error(`❌ Ошибка подключения к @${streamerUsername}:`, err.message);
        delete activeMonitors[streamerUsername];
    }
}
