function decodeBase64Prefix(base64, maxBytes) {
    if (typeof base64 !== "string") return [];

    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var bytes = [];
    var buffer = 0;
    var bits = 0;

    for (var i = 0; i < base64.length && bytes.length < maxBytes; i++) {
        var character = base64.charAt(i);
        if (/\s/.test(character)) continue;
        if (character === "=") break;

        var value = alphabet.indexOf(character);
        if (value < 0) return [];

        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
            buffer = buffer & ((1 << bits) - 1);
        }
    }

    return bytes;
}

function bytesEqual(bytes, offset, expected) {
    if (bytes.length < offset + expected.length) return false;
    for (var i = 0; i < expected.length; i++) {
        if (bytes[offset + i] !== expected[i]) return false;
    }
    return true;
}

function bytesToAscii(bytes, offset, length) {
    if (bytes.length < offset + length) return "";
    var value = "";
    for (var i = offset; i < offset + length; i++) {
        value += String.fromCharCode(bytes[i]);
    }
    return value;
}

function readUint32BigEndian(bytes, offset) {
    if (bytes.length < offset + 4) return null;
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function detectIsoBmffMimeType(base64, prefix) {
    var boxSize = readUint32BigEndian(prefix, 0);
    var majorBrandOffset = 8;
    // 含空白 / padding 时只是上界，截断仍由下面的流式扫描检查。
    var maxDecodedBytes = Math.floor(base64.length * 3 / 4);

    if (boxSize === 1) {
        var largeSizeHigh = readUint32BigEndian(prefix, 8);
        var largeSizeLow = readUint32BigEndian(prefix, 12);
        if (largeSizeHigh === null || largeSizeLow === null ||
            largeSizeHigh > Math.floor(maxDecodedBytes / 0x100000000)) return null;
        boxSize = largeSizeHigh * 0x100000000 + largeSizeLow;
        majorBrandOffset = 16;
    } else if (boxSize === 0) {
        // size=0 表示直到文件结尾；只计数，不将完整图片解码到数组。
        boxSize = base64ByteLength(base64);
    }

    // ftyp 必须包含 major_brand、minor_version 和完整的 4 字节兼容品牌。
    if (boxSize === null || boxSize < majorBrandOffset + 8 || boxSize % 4 !== 0 || boxSize > maxDecodedBytes) return null;

    var hasAvifBrand = false;
    var hasHeicBrand = false;
    var hasHeifBrand = false;
    var hasSequenceBrand = false;
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var buffer = 0;
    var bits = 0;
    var byteOffset = 0;
    var brand = 0;

    // 逐字节读取整个 ftyp，内存始终只保留一个品牌；到盒边界立即停止，
    // 不解码后续图片内容，也不会把后续盒中的品牌字样当成兼容品牌。
    for (var index = 0; index < base64.length && byteOffset < boxSize; index++) {
        var code = base64.charCodeAt(index);
        if (code === 9 || code === 10 || code === 13 || code === 32) continue;
        if (code === 61) break;
        var value = alphabet.indexOf(base64.charAt(index));
        if (value < 0) return null;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits < 8) continue;
        bits -= 8;
        var byte = (buffer >> bits) & 0xff;
        buffer = buffer & ((1 << bits) - 1);
        byteOffset++;
        if (byteOffset <= majorBrandOffset) continue;

        brand = brand * 0x100 + byte;
        if ((byteOffset - majorBrandOffset) % 4 !== 0) continue;
        if (byteOffset !== majorBrandOffset + 8) { // minor_version 不是品牌字段
            switch (brand) {
                case 0x61766966: hasAvifBrand = true; break; // avif
                case 0x68656963: // heic
                case 0x68656978: // heix
                case 0x6865696d: // heim
                case 0x68656973: hasHeicBrand = true; break; // heis
                case 0x6d696631: hasHeifBrand = true; break; // mif1
                case 0x61766973: // avis
                case 0x6176696f: // avio
                case 0x68657663: // hevc
                case 0x68657678: // hevx
                case 0x6865766d: // hevm
                case 0x68657673: // hevs
                case 0x6d736631: hasSequenceBrand = true; break; // msf1
            }
        }
        brand = 0;
    }

    // 序列文件可能同时声明 still-image 品牌；维持单图 OCR 对序列的拒绝策略。
    if (byteOffset !== boxSize || hasSequenceBrand) return null;
    if (hasAvifBrand) return "image/avif";
    if (hasHeicBrand) return "image/heic";
    if (hasHeifBrand) return "image/heif";
    return null;
}

// 检测 Mistral OCR 支持的常见图片格式。未知格式返回 null，禁止伪装成 PNG 上传。
function detectMimeType(base64) {
    var bytes = decodeBase64Prefix(base64, 64);

    if (bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

    var gifHeader = bytesToAscii(bytes, 0, 6);
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";

    if (bytesToAscii(bytes, 0, 4) === "RIFF" && bytesToAscii(bytes, 8, 4) === "WEBP") {
        return "image/webp";
    }

    if (bytesEqual(bytes, 0, [0x42, 0x4d])) return "image/bmp";
    if (bytesEqual(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesEqual(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
        return "image/tiff";
    }

    // AVIF / HEIC / HEIF 使用 ISO BMFF 容器。扫描全部品牌后按更具体的格式优先返回。
    if (bytesToAscii(bytes, 4, 4) === "ftyp") {
        return detectIsoBmffMimeType(base64, bytes);
    }

    return null;
}

// 只计数字符，不复制或完整解码大图；同时拒绝损坏的 Base64。
function base64ByteLength(base64) {
    var symbols = 0;
    var padding = 0;
    for (var index = 0; index < base64.length; index++) {
        var code = base64.charCodeAt(index);
        if (code === 9 || code === 10 || code === 13 || code === 32) continue;
        if (code === 61) {
            padding++;
            if (padding > 2) return null;
            continue;
        }
        if (padding || !((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) || code === 43 || code === 47)) return null;
        symbols++;
    }
    if (symbols % 4 === 1 || (padding && (symbols + padding) % 4 !== 0)) return null;
    return Math.floor(symbols * 6 / 8);
}
