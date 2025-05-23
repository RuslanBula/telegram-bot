require('dotenv').config();
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');

// Підключення до MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Модель відгуку
const reviewSchema = new mongoose.Schema({
    identifier: { type: String, required: true },
    rating: { type: Number, required: true }, // зіркова оцінка
    review: { type: String }, // відгук може бути порожнім
    userId: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Review = mongoose.model('Review', reviewSchema);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Константи
const LIMIT = 3;
const WAIT_TIME = 4 * 60 * 60 * 1000; // 4 години

// Кеш станів користувачів
function normalizeIdentifier(input) {
    const text = input.toString().trim();
    if (/^\d{4}$/.test(text)) {
        return text;
    }
    return text.toUpperCase().replace(/^@/, '');
}
const userStates = new Map();

// Функція головного меню
function sendMainMenu(chatId) {
    userStates.delete(chatId);
    bot.sendMessage(chatId,
        'Привіт! Раді бачити вас в нашому боті.\nЩо вас цікавить?',
        {
            reply_markup: {
                keyboard: [
                    ['Знайти інформацію🔎'],
                    ['Залишити відгук⭐'],
                    ['Підтримка⚙']
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        }
    );
}

// Збереження відгуку (позбавлене від дублювань за 4 години)
async function saveReview(identifier, reviewText, userId, rating) {
    try {
        const lastReview = await Review.findOne({
            userId,
            timestamp: { $gte: new Date(Date.now() - WAIT_TIME) }
        }).sort({ timestamp: -1 });

        if (lastReview) return false;

        await Review.create({
            identifier: normalizeIdentifier(identifier),
            review: reviewText,
            userId,
            rating,
            timestamp: new Date()
        });
        return true;
    } catch (err) {
        console.error('Помилка збереження відгуку:', err);
        return false;
    }
}

// Показ відгуків та статистики
async function showReviews(chatId, identifier) {
    try {
        const allReviews = await Review.find({ identifier: normalizeIdentifier(identifier) }).sort({ timestamp: -1 });
        const total = allReviews.length;

        if (total === 0) {
            await bot.sendMessage(chatId, 'Відгуків не знайдено 🙅‍♂️');
        } else {
            let message = `Статистика💡\n• Всього відгуків: ${total} 📍\n\nОсь, які відгуки ми знайшли:\n`;

            const latestReviews = allReviews.slice(0, LIMIT);
            latestReviews.forEach((review) => {
                if (review.review && review.review.trim()) {
                    message += `📍 «${review.review.trim()}»\n`;
                }
            });

            await bot.sendMessage(chatId, message);
        }

        // Чекаємо 3 секунди, потім показуємо меню
        await new Promise(resolve => setTimeout(resolve, 3000));
        await sendMainMenu(chatId);

    } catch (err) {
        console.error('Помилка отримання відгуків:', err);
        await bot.sendMessage(chatId, 'Сталася помилка при отриманні відгуків. Спробуйте пізніше.');
    }
}

// Обробка /start
bot.onText(/\/start/, (msg) => {
    sendMainMenu(msg.chat.id);
});

// Обробка callback-кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('confirm_review:')) {
        const key = Number(data.split(':')[1]); // щоб точно отримати chatId як число
        const state = userStates.get(key);

        if (!state) {
            return bot.sendMessage(chatId, 'Не вдалося знайти дані для підтвердження.');
        }

        const saved = await saveReview(state.identifier, state.review, state.userId, state.rating);

        if (!saved) {
            return bot.sendMessage(chatId,
                'Ви можете залишати відгуки про одного користувача/авто не частіше ніж раз на 4 години.',
                { parse_mode: 'Markdown' }
            ).then(() => {
                setTimeout(() => {
                    sendMainMenu(chatId);
                }, 3000);
            });
        }

        userStates.delete(key);

        await bot.sendMessage(chatId, '✅ Ваш відгук збережено! Дякуємо за внесок.');

        setTimeout(() => {
            sendMainMenu(chatId);
        }, 3000);
    }

    if (data === 'cancel_review') {
        userStates.delete(chatId);
        return sendMainMenu(chatId);
    }

    if (data.startsWith('rating_')) {
        const rating = Number(data.split('_')[1]);
        const state = userStates.get(chatId);

        if (!state || !state.identifier) {
            return bot.sendMessage(chatId, 'Щось пішло не так. Спробуйте спочатку.');
        }

        // Зберігаємо оцінку і чекаємо текстового відгуку або пропуску
        state.rating = rating;
        state.step = 'awaiting_optional_review';
        userStates.set(chatId, state);

        return bot.sendMessage(chatId,
            `Ви поставили ${rating}⭐️\n\nХочете залишити текстовий коментар? Введіть його або натисніть “Пропустити”.`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Пропустити', callback_data: 'skip_review' }]
                    ]
                }
            }
        );
    }

    if (data === 'skip_review') {
        const state = userStates.get(chatId);
        if (!state || !state.identifier || !state.rating) {
            return bot.sendMessage(chatId, 'Щось пішло не так. Спробуйте спочатку.');
        }

        userStates.set(chatId, {
            ...state,
            step: 'awaiting_confirmation',
            review: ''
        });

        return bot.sendMessage(chatId,
            `Підтверджуєте надсилання ${state.rating}⭐️ без текстового коментаря?`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: ' Так, підтверджую', callback_data: `confirm_review:${chatId}` }],
                        [{ text: ' Скасувати', callback_data: 'cancel_review' }]
                    ]
                }
            }
        );
    }
});

// Обробка звичайних повідомлень
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    if (!userStates.has(chatId)) {
        if (text === 'Знайти інформацію🔎') {
            userStates.set(chatId, { step: 'awaiting_identifier_search' });
            return bot.sendMessage(chatId,
                'Введіть номер авто (Великими, англійськими літерами, наприклад, AB1234CD) або @нікнейм користувача чи 4 цифри, щоб переглянути відгуки.',
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        }

        if (text === 'Залишити відгук⭐') {
            userStates.set(chatId, { step: 'awaiting_identifier_review' });
            return bot.sendMessage(chatId,
                'Щоб залишити відгук, введіть номер авто (Великими, англійськими літерами, наприклад AB1234CD) або @нікнейм користувача чи 4 цифри.',
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        } 

        if (text === 'Підтримка⚙') {
            return bot.sendMessage(chatId, 'Звʼяжіться з підтримкою: @aaghsnnn');
        }

        // Якщо користувач нічого з меню не натиснув і не в процесі — нічого не робимо
        return;
    }

    const state = userStates.get(chatId);
    if (!state) return;

    const validPlate = /^[A-Z]{2}\d{4}[A-Z]{2}$/;
    const validNickname = /^@[\w\d_]{5,}$/;
    const validFourDigits = /^\d{4}$/;

    function isValidIdentifier(text) {
        return validPlate.test(text.toUpperCase())
            || validNickname.test(text)
            || validFourDigits.test(text);
    }

    if (state.step === 'awaiting_identifier_search') {
        if (!isValidIdentifier(text)) {
            return bot.sendMessage(chatId,
                'Неправильний формат! Введіть номер авто (наприклад, AB1234CD) або @нікнейм користувача чи 4 цифри.',
                { parse_mode: 'Markdown' });
        }
        return showReviews(chatId, normalizeIdentifier(text));    }

    if (state.step === 'awaiting_identifier_review') {
        if (!isValidIdentifier(text)) {
            return bot.sendMessage(chatId,
                'Неправильний формат! Введіть номер авто (наприклад, AB1234CD) або @нікнейм користувача чи 4 цифри.',
                { parse_mode: 'Markdown' });
        }

        userStates.set(chatId, {
            step: 'awaiting_rating',
            identifier: text.toUpperCase(),
            userId: msg.from.id
        });

        return bot.sendMessage(chatId,
            'Оцініть підсадку від 1 до 5⭐️\n\nНатисніть на одну із зірочок нижче✨',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '1⭐️', callback_data: 'rating_1' },
                            { text: '2⭐️', callback_data: 'rating_2' }],
                        [{ text: '3⭐️', callback_data: 'rating_3' },
                            { text: '4⭐️', callback_data: 'rating_4' }],
                        [{ text: '5⭐️', callback_data: 'rating_5' }]
                    ]
                }
            }
        );
    }
    else if (state.step === 'awaiting_optional_review') {
        const key = chatId;

        userStates.set(key, {
            ...state,
            review: text,
            step: 'awaiting_confirmation'
        });

        return bot.sendMessage(chatId,
            `Підтверджуєте надсилання ${state.rating}⭐️ з таким коментарем?\n\n«${text}»`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Так, підтверджую', callback_data: `confirm_review:${key}` }],
                        [{ text: 'Скасувати', callback_data: 'cancel_review' }]
                    ]
                }
            }
        );
    }

// Збереження відгуку
    async function saveReview(identifier, reviewText, userId, rating) {
        try {
            const lastReview = await Review.findOne({
                userId,
                timestamp: { $gte: new Date(Date.now() - WAIT_TIME) }
            }).sort({ timestamp: -1 });

            if (lastReview) return false;

            await Review.create({
                identifier,
                review: reviewText,
                userId,
                rating,
                timestamp: new Date()
            });

            return true;
        } catch (err) {
            console.error('Помилка збереження відгуку:', err);
            return false;
        }
    }


// Показ відгуків
// Показ відгуків + статистика (кількість)
    const averageRating = allReviews.reduce((acc, r) => acc + r.rating, 0) / total;
    message = `Статистика💡\n• Всього відгуків: ${total} 📍\n• Середня оцінка: ${averageRating.toFixed(1)}⭐️\n\nОсь, які відгуки ми знайшли:\n`;
    async function showReviews(chatId, identifier) {
        try {
            const allReviews = await Review.find({ identifier }).sort({ timestamp: -1 });
            const total = allReviews.length;

            if (total === 0) {
                await bot.sendMessage(chatId, 'Відгуків не знайдено 🙅‍♂️');
            } else {
                const ratings = allReviews
                    .map(r => parseFloat(r.rating))
                    .filter(r => !isNaN(r));

                const totalRatings = ratings.length;
                const averageRating = totalRatings > 0
                    ? ratings.reduce((sum, r) => sum + r, 0) / totalRatings
                    : 0;

                let message = `Статистика💡\n\n• Рейтинг: ${averageRating.toFixed(1)}⭐️\n• Всього відгуків: ${total} 📍\n\n`;
                message += 'Ось, які відгуки ми знайшли:\n\n';

                const latestReviews = allReviews.filter(r => r.review && r.review.trim());                latestReviews.forEach((review) => {
                    if (review.review && review.review.trim()) {
                        message += `📍 «${review.review.trim()}»\n`;
                    }
                });

                await bot.sendMessage(chatId, message);
            }

            // Повернення до головного меню
            await new Promise(resolve => setTimeout(resolve, 2000));
            return sendMainMenu(chatId);

        } catch (err) {
            console.error('Помилка отримання відгуків:', err);
            await bot.sendMessage(chatId, 'Сталася помилка при отриманні відгуків. Спробуйте пізніше.');
            return sendMainMenu(chatId);
        }
    }
});