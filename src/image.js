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
        var boxSize = readUint32BigEndian(bytes, 0);
        var majorBrandOffset = 8;
        var minorVersionOffset = 12;
        var brandScanEnd;

        if (boxSize === 1) {
            // large-size ftyp：8 字节扩展长度位于 box type 后，品牌字段整体后移。
            var largeSizeHigh = readUint32BigEndian(bytes, 8);
            var largeSizeLow = readUint32BigEndian(bytes, 12);
            if (largeSizeHigh === null || largeSizeLow === null || (largeSizeHigh === 0 && largeSizeLow < 24)) return null;
            majorBrandOffset = 16;
            minorVersionOffset = 20;
            brandScanEnd = largeSizeHigh === 0 ? Math.min(largeSizeLow, bytes.length) : bytes.length;
        } else {
            if (boxSize === null || (boxSize !== 0 && boxSize < 16)) return null;
            brandScanEnd = boxSize === 0 ? bytes.length : Math.min(boxSize, bytes.length);
        }

        var hasAvifBrand = false;
        var hasAvifSequenceBrand = false;
        var hasHeicBrand = false;
        var hasHeifBrand = false;
        var hasHeicSequenceBrand = false;
        var hasHeifSequenceBrand = false;
        for (var brandOffset = majorBrandOffset; brandOffset + 4 <= brandScanEnd; brandOffset += 4) {
            if (brandOffset === minorVersionOffset) continue; // minor_version，不是品牌字段
            var brand = bytesToAscii(bytes, brandOffset, 4);
            if (brand === "avif") hasAvifBrand = true;
            if (brand === "avis" || brand === "avio") hasAvifSequenceBrand = true;
            if (brand === "heic" || brand === "heix" || brand === "heim" || brand === "heis") hasHeicBrand = true;
            if (brand === "mif1") hasHeifBrand = true;
            if (brand === "hevc" || brand === "hevx" || brand === "hevm" || brand === "hevs") {
                hasHeicSequenceBrand = true;
            }
            if (brand === "msf1") hasHeifSequenceBrand = true;
        }
        // Mistral 的单图 OCR 未明确支持图像序列；序列文件也可能同时声明 still-image 品牌，故优先拒绝。
        if (hasAvifSequenceBrand || hasHeicSequenceBrand || hasHeifSequenceBrand) return null;
        if (hasAvifBrand) return "image/avif";
        if (hasHeicBrand) return "image/heic";
        if (hasHeifBrand) return "image/heif";
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
