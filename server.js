const express = require('express');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');

// Настраиваем веб-сервер Express
const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Supabase
const SUPABASE_URL = 'https://zagvyrqnayxdbqkcjqud.supabase.co';
const SUPABASE_KEY = 'sb_publishable_glnqsWdFcmaHOzUrfD5fGA_dt6xiB1f';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Хранилище активных мониторингов
const activeMonitors = {};

// Главный маршрут: отдаем виджет и запускаем сборщик
app.get('/', (req, res) => {
    const username = req.query.user || req.query.username;

    if (username) {
        startMonitoring(username);
    }

    res.sendFile(path.join(__dirname, 'index.html'));
});

// Система "Пульса": OBS виджет пингует этот роут, подтверждая что он открыт
app.get('/ping', (req, res) => {
    const username = req.query.user;
    if (username) {
        if (!activeMonitors[username]) {
            startMonitoring(username); // Запускаем заново, если был удален
        } else {
            activeMonitors[username].lastPing = Date.now(); // Обновляем таймер
        }
    }
    res.sendStatus(200);
});

// Очистка старых сессий (Защита от засирания памяти сервера)
// Раз в минуту проверяем, не закрыли ли виджет в OBS
setInterval(() => {
    const now = Date.now();
    for (const user in activeMonitors) {
        // Если пульса не было 5 минут (виджет закрыли)
        if (now - activeMonitors[user].lastPing > 5 * 60 * 1000) {
            console.log(`🛑 Виджет @${user} закрыт в OBS. Отключаем мониторинг для экономии ресурсов.`);
            if (activeMonitors[user].connection) {
                try { activeMonitors[user].connection.disconnect(); } catch (e) {}
            }
            delete activeMonitors[user];
        }
    }
}, 60000);

// Запускаем сервер
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Web-сервер успешно запущен на порту ${PORT}`);
});

// Запуск мониторинга
async function startMonitoring(streamerUsername) {
    if (activeMonitors[streamerUsername]) return;

    activeMonitors[streamerUsername] = {
        lastPing: Date.now(),
        localGiftersData: {},
        connection: null,
        isConnecting: false
    };

    console.log(`⏳ Загрузка истории донатов @${streamerUsername} из БД...`);
    
    // 1. ЗАГРУЖАЕМ СТАРУЮ ИСТОРИЮ (ЧТОБЫ СУММИРОВАТЬ)
    try {
        const { data, error } = await supabase
            .from('top_gifters')
            .select('*')
            .eq('streamer_username', streamerUsername);
            
        if (!error && data) {
            data.forEach(g => {
                activeMonitors[streamerUsername].localGiftersData[g.gifter_username] = g;
            });
            console.log(`✅ История загружена. Ранее дарили: ${data.length} чел.`);
        }
    } catch (err) {
        console.error("❌ Ошибка загрузки истории:", err.message);
    }

    // 2. ПОДКЛЮЧАЕМСЯ К СТРИМУ
    connectToTikTok(streamerUsername);
}

// Функция цикличного подключения
function connectToTikTok(streamerUsername) {
    const monitor = activeMonitors[streamerUsername];
    if (!monitor || monitor.isConnecting) return; // Если удалили сборщиком мусора или уже в процессе

    monitor.isConnecting = true;
    const tiktokLiveConnection = new WebcastPushConnection(streamerUsername);
    monitor.connection = tiktokLiveConnection;

    // Обработка подарков
    tiktokLiveConnection.on('gift', async data => {
        if (data.giftType === 1 && !data.repeatEnd) return; // Пропуск спам-комбо

        const gifter = data.uniqueId;
        const coins = data.diamondCount * data.repeatCount;

        if (!monitor.localGiftersData[gifter]) {
            monitor.localGiftersData[gifter] = {
                streamer_username: streamerUsername,
                gifter_username: gifter,
                gifter_nickname: data.nickname,
                avatar_url: data.profilePictureUrl,
                coins: 0 // Если новый, начинаем с 0
            };
        }

        // Прибавляем к общей истории
        monitor.localGiftersData[gifter].coins += coins;
        monitor.localGiftersData[gifter].updated_at = new Date().toISOString();

        // Обновляем БД (Supabase)
        const { error } = await supabase
            .from('top_gifters')
            .upsert(monitor.localGiftersData[gifter], { onConflict: 'streamer_username, gifter_username' });

        if (error) console.error("❌ Ошибка записи в БД:", error.message);
    });

    // Обработка отключения
    tiktokLiveConnection.on('disconnected', () => {
        monitor.isConnecting = false;
        // Переподключение через 5 секунд
        if (activeMonitors[streamerUsername]) {
            setTimeout(() => connectToTikTok(streamerUsername), 5000);
        }
    });

    // Глушим ошибки, чтобы не спамить в логи и не "засирать" сервер Railway
    tiktokLiveConnection.on('error', err => {});

    // Попытка подключения
    tiktokLiveConnection.connect().then(() => {
        console.log(`📡 Успешно подключено к стриму @${streamerUsername}`);
        monitor.isConnecting = false;
    }).catch(err => {
        monitor.isConnecting = false;
        // Если стример оффлайн - повторяем тихо через 5 секунд
        if (activeMonitors[streamerUsername]) {
            setTimeout(() => connectToTikTok(streamerUsername), 5000);
        }
    });
}
