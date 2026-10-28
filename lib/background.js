const { waitUntil } = require('@vercel/functions');

// Retain work after the response on Vercel; locally, the pending promise
// runs in the Node process. Always observe rejections.
function runBackground(task) {
    const observed = Promise.resolve(task).catch(error => {
        console.error('[background] Task failed:', error.message);
    });
    waitUntil(observed);
    return observed;
}

module.exports = { runBackground };
