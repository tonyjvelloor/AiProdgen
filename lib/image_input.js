function decodeImage(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw Object.assign(new Error('Upload a PNG, JPEG or WebP image.'), { status: 400 });
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
        throw Object.assign(new Error('Upload an image smaller than 3 MB.'), { status: 400 });
    }
    const mimeType = match[1];
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
    return { buffer, mimeType, extension };
}

module.exports = { decodeImage };
