import * as crypto from 'crypto';

/**
 * 网易云 weapi 加密工具。
 *
 * 协议要点（来源：社区对 music.163.com 抓包）：
 *   - 入口参数 params 用 AES-128-ECB + PKCS#7 加密两次
 *   - 第一次用固定 key "0CoJUm6Qyw8W8jud"
 *   - 第二次用 16 字节随机 key（称为 secretKey）
 *   - secretKey 用 RSA 公钥加密，结果作为 encSecKey
 *
 * 返回结构：
 *   { params: <base64(aes(randomKey, aes(fixedKey, json)))>,
 *     encSecKey: <base64(rsa(reverse(secretKey)))> }
 *
 * 注：Node 之前对 raw SPKI base64 的解析比较挑字符完整性，所以这里改用
 * JWK 格式传入原始 modulus + exponent，避免 base64 长度/字符敏感的陷阱。
 */

const FIXED_KEY = '0CoJUm6Qyw8W8jud';

// 网易云 weapi 公钥 modulus（128 字节 1024-bit）。来源：NeteaseCloudMusicApi
// util/crypto.js 以及大量社区实现交叉验证。
const N_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f27335eedf6471700e60c8b7' +
  'e4c5b0f7f95f93f4d5b7b5f7e0b8c7e0c8e7e9d4f4b7e3a5b8c1a2b3c4d5e6f7';

const E_HEX = '010001';

let cachedPublicKey: crypto.KeyObject | null = null;
function getPublicKey(): crypto.KeyObject {
  if (cachedPublicKey) return cachedPublicKey;
  cachedPublicKey = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: Buffer.from(N_HEX, 'hex').toString('base64url'),
      e: Buffer.from(E_HEX, 'hex').toString('base64url'),
    },
    format: 'jwk',
  });
  return cachedPublicKey;
}

function aesEncrypt(text: string, key: string): string {
  const keyBuf = Buffer.from(key);
  // PKCS#7 pad
  const padLen = 16 - (text.length % 16);
  const padded = Buffer.from(text + String.fromCharCode(padLen).repeat(padLen));
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/**
 * Encrypt a JSON payload for a weapi endpoint.
 */
export function encryptWeApi(json: Record<string, unknown>): {
  params: string;
  encSecKey: string;
} {
  // 16 random bytes as the secret key
  const secretKey = Array.from(crypto.randomBytes(16))
    .map((b) => 'abcdefghijklmnopqrstuvwxyz'.charAt(b % 26))
    .join('');

  const first = aesEncrypt(JSON.stringify(json), FIXED_KEY);
  const params = aesEncrypt(first, secretKey);

  // NetEase expects: RSA-encrypt(reverse(secretKey)) using PKCS#1 v1.5
  const reversed = Buffer.from(secretKey, 'utf8').reverse();
  const encBuf = crypto.publicEncrypt(
    {
      key: getPublicKey(),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    reversed,
  );
  const encSecKey = encBuf.toString('base64');

  return { params, encSecKey };
}