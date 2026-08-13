// QQ 官方机器人 webhook 的 Ed25519 签名 / 验签。
// 密钥由 AppSecret 派生：seed 不足 32 字节则自我重复补齐，取前 32 字节（与官方 Go 示例一致）。
// Workers WebCrypto 支持标准 "Ed25519"；私钥用 PKCS8 包装 seed 导入，公钥经 JWK 导出再导入。

const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function deriveSeed(secret: string): Uint8Array {
  let bytes = new TextEncoder().encode(secret);
  while (bytes.length < 32) {
    const next = new Uint8Array(bytes.length * 2);
    next.set(bytes);
    next.set(bytes, bytes.length);
    bytes = next;
  }
  return bytes.slice(0, 32);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return new Uint8Array();
    out[i] = b;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function getKeyPair(secret: string): Promise<{ priv: CryptoKey; pub: CryptoKey }> {
  const seed = deriveSeed(secret);
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  const priv = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const pub = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: jwk.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return { priv, pub };
}

/** 校验回调签名：待签内容为 timestamp + 原始 body，签名为 hex（64 字节） */
export async function verifyQQSignature(
  secret: string,
  sigHex: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  if (!secret || !sigHex || !timestamp) return false;
  const sig = hexToBytes(sigHex);
  if (sig.length !== 64 || (sig[63] & 224) !== 0) return false;
  try {
    const { pub } = await getKeyPair(secret);
    const msg = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, msg);
  } catch (e) {
    console.warn("[qqbot] 验签异常:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** op=13 回调地址验证：签名内容为 event_ts + plain_token */
export async function signQQValidation(secret: string, eventTs: string, plainToken: string): Promise<string> {
  const { priv } = await getKeyPair(secret);
  const msg = new TextEncoder().encode(eventTs + plainToken);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, msg);
  return bytesToHex(new Uint8Array(sig));
}
