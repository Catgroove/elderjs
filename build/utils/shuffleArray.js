"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
exports.default = shuffleArray;
