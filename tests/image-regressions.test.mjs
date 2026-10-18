import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
new vm.Script(await readFile(new URL("../src/image.js", import.meta.url), "utf8"), { filename: "src/image.js" }).runInContext(context);

function ftyp({ major = "mif1", brands = [], extended = false, toEnd = false, minor = Buffer.alloc(4) } = {}) {
  const headerSize = extended ? 16 : 8;
  const bytes = Buffer.alloc(headerSize + 8 + brands.length * 4);
  bytes.writeUInt32BE(extended ? 1 : toEnd ? 0 : bytes.length, 0);
  bytes.write("ftyp", 4);
  if (extended) bytes.writeBigUInt64BE(BigInt(bytes.length), 8);
  bytes.write(major, headerSize);
  minor.copy(bytes, headerSize + 4);
  brands.forEach((brand, index) => bytes.write(brand, headerSize + 8 + index * 4));
  return bytes;
}

function mime(bytes) {
  return context.detectMimeType(bytes.toString("base64"));
}

test("ftyp reads specific compatible brands after the first 64 bytes", () => {
  for (const [brand, expected] of [["avif", "image/avif"], ["heic", "image/heic"], ["heix", "image/heic"]]) {
    for (const extended of [false, true]) {
      const bytes = ftyp({ brands: [...Array(20).fill("zzzz"), brand], extended });
      assert.ok(bytes.indexOf(brand) >= 64);
      assert.equal(mime(bytes), expected);
    }
  }
  assert.equal(mime(ftyp({ major: "heic", brands: [...Array(20).fill("zzzz"), "avif"] })), "image/avif");
});

test("sequence brands after byte 64 reject still-image containers for every ftyp size form", () => {
  for (const brand of ["avis", "avio", "hevc", "hevx", "hevm", "hevs", "msf1"]) {
    for (const sizeOptions of [{}, { extended: true }, { toEnd: true }]) {
      const bytes = ftyp({ major: "avif", brands: [...Array(20).fill("zzzz"), brand], ...sizeOptions });
      assert.ok(bytes.indexOf(brand) >= 64);
      assert.equal(mime(bytes), null, `${brand} must reject ${JSON.stringify(sizeOptions)}`);
    }
  }
});

test("size-zero ftyp scans through EOF and handles wrapped or unpadded Base64", () => {
  const bytes = ftyp({ brands: [...Array(20).fill("zzzz"), "avif"], toEnd: true });
  assert.equal(mime(bytes), "image/avif");
  const wrapped = bytes.toString("base64").replace(/.{1,19}/g, "$&\r\n");
  assert.equal(context.detectMimeType(wrapped), "image/avif");
  assert.equal(context.detectMimeType(bytes.toString("base64").replace(/=+$/, "")), "image/avif");
  assert.equal(mime(Buffer.concat([bytes, Buffer.from("x")])), null, "partial trailing brand is malformed");
});

test("ftyp ignores minor_version and bytes outside the declared box", () => {
  for (const extended of [false, true]) {
    const header = ftyp({ extended, minor: Buffer.from("avis") });
    const followingBox = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("mdatavifavis")]);
    assert.equal(mime(Buffer.concat([header, followingBox])), "image/heif");
  }
});

test("truncated headers, oversized declarations, and partial ftyp brands are rejected", () => {
  for (const extended of [false, true]) {
    const valid = ftyp({ major: "avif", brands: [...Array(20).fill("zzzz")], extended });
    const headerSize = extended ? 24 : 16;
    for (let length = 0; length < headerSize; length++) assert.equal(mime(valid.subarray(0, length)), null);
    assert.equal(mime(valid.subarray(0, valid.length - 4)), null, "declared box must be complete");
    assert.equal(mime(valid.subarray(0, valid.length - 1)), null, "truncated final brand must be rejected");

    const misaligned = Buffer.concat([ftyp({ major: "avif", extended }), Buffer.from("xx")]);
    if (extended) misaligned.writeBigUInt64BE(BigInt(misaligned.length), 8);
    else misaligned.writeUInt32BE(misaligned.length, 0);
    assert.equal(mime(misaligned), null);
  }
  const hugeExtended = ftyp({ major: "avif", extended: true });
  hugeExtended.writeBigUInt64BE(0x100000018n, 8);
  assert.equal(mime(hugeExtended), null);
  assert.equal(mime(ftyp({ major: "avif", extended: true }).subarray(0, 16)), null);
});

test("large ftyp scans all brands while later image data does not affect detection", { timeout: 10_000 }, () => {
  const box = Buffer.alloc(1024 * 1024);
  box.writeUInt32BE(box.length);
  box.write("ftypmif1", 4);
  box.write("avif", box.length - 4);
  assert.equal(mime(box), "image/avif");

  const imageData = Buffer.alloc(20 * 1024 * 1024 - 16);
  imageData.write("avifavis");
  assert.equal(mime(Buffer.concat([ftyp(), imageData])), "image/heif");
});
