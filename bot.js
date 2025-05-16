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
    review: { type: String, required: true },
    userId: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Review = mongoose.model('Review', reviewSchema);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Видаляємо всі команди, щоб не показувалося меню під полем вводу
bot.setMyCommands([]);
const userStates = new Map();

const LIMIT = 3;
const WAIT_TIME = 4 * 60 * 60 * 1000; // 4 години

// Головне меню
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

// Старт
bot.onText(/\/start/, (msg) => {
    sendMainMenu(msg.chat.id);
});

// Обробка callback кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('confirm_review:')) {
        const key = data.split(':')[1];
        const state = userStates.get(key);

        if (!state) {
            return bot.sendMessage(chatId, 'Не вдалося знайти дані для підтвердження.');
        }

        const saved = await saveReview(state.identifier, state.review, state.userId);

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
});
// Обробка повідомлень
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;
    if (!userStates.has(chatId)) {
        if (text === 'Знайти інформацію🔎') {
            userStates.set(chatId, { step: 'awaiting_identifier_search' });
            return bot.sendMessage(chatId,
                'Введіть номер авто (наприклад, AB1234CD) або @нікнейм користувача, щоб переглянути відгуки.',
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        }

        if (text === 'Залишити відгук⭐') {
            userStates.set(chatId, { step: 'awaiting_identifier_review' });
            return bot.sendMessage(chatId,
                'Щоб залишити відгук, введіть номер авто (Великими, англійськими літерами, наприклад AB1234CD) або @нікнейм користувача.',
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        }

        if (text === 'Підтримка⚙') {
            return bot.sendMessage(chatId, 'Звʼяжіться з підтримкою: @aaghsnnn');
        }

        // Якщо користувач нічого з меню не натиснув і не в процесі — не робимо нічого
        return;
    }
    const state = userStates.get(chatId);
    if (!state) return;

    if (state.step === 'awaiting_identifier_search') {
        return showReviews(chatId, text.toUpperCase());
    }

    if (state.step === 'awaiting_identifier_review') {
        const validPlate = /^[A-Z]{2}\d{4}[A-Z]{2}$/;
        const validNickname = /^@[\w\d_]{5,}$/;

        if (!validPlate.test(text) && !validNickname.test(text)) {
            return bot.sendMessage(chatId,
                'Неправильний формат! Введіть номер авто (наприклад, AB1234CD) або @нікнейм користувача.',
                { parse_mode: 'Markdown' });
        }

        userStates.set(chatId, {
            step: 'awaiting_review_text',
            identifier: text.toUpperCase(),
            userId: msg.from.id
        });
        return bot.sendMessage(chatId,
            'Дякую! Тепер напишіть свій відгук.\nПриклад: «Легкове авто, все чисто та швидко доїхав»',
            { reply_markup: { remove_keyboard: true } });
    }

    const confirmKey = `${chatId}_${Date.now()}`;
    userStates.set(confirmKey, {
        identifier: state.identifier,
        review: text,
        userId: state.userId
    });

    return bot.sendMessage(chatId,
        'Підтверджуєте відправлення відгуку?',
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Так, надіслати', callback_data: `confirm_review:${confirmKey}` },
                        { text: 'Скасувати', callback_data: 'cancel_review' }
                    ]
                ]
            }
        }
    );
}); // <-- Ось ця закриваюча дужка!

// Збереження відгуку
async function saveReview(identifier, reviewText, userId) {
    try {
        const lastReview = await Review.findOne({
            identifier,
            userId,
            timestamp: { $gte: new Date(Date.now() - WAIT_TIME) }
        }).sort({ timestamp: -1 });

        if (lastReview) return false;

        await Review.create({
            identifier,
            review: reviewText,
            userId,
            timestamp: new Date()
        });

        return true;
    } catch (err) {
        console.error('Помилка збереження відгуку:', err);
        return false;
    }
}

// Показ відгуків
async function showReviews(chatId, identifier) {
    try {
        const reviews = await Review.find({ identifier })
            .sort({ timestamp: -1 })
            .limit(LIMIT);

        if (reviews.length === 0) {
            await bot.sendMessage(chatId, 'Відгуків не знайдено 🙅‍♂️');
        } else {
            let message = `Ось, які відгуки ми знайшли..\n`;
            reviews.forEach((review) => {
                message += `📍«${review.review}»\n`;
            });
            await bot.sendMessage(chatId, message);
        }
        // Через 3 секунди повернути меню
        setTimeout(() => {
            sendMainMenu(chatId);
        }, 3000);

    } catch (err) {
        console.error('Помилка отримання відгуків:', err);
        await bot.sendMessage(chatId, 'Сталася помилка при отриманні відгуків. Спробуйте пізніше.');
    }
}
