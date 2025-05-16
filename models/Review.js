const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
    identifier: { type: String, required: true },
    review: { type: String, required: true },
    userId: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Review', reviewSchema);
