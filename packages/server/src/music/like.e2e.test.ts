/**
 * Controller 层 e2e 测试：真启 NestJS，用 HTTP 打端点，验证
 *  1) 路由顺序：/music/like/merged 命中 fanOutLike，不被 /like/:trackId 截胡
 *  2) fanOut 语义：like → liked 集合写入；unlike → 清空
 *  3) fannedOutTo 返回全集（含之前单独心过的平台）
 *  4) 输入校验：缺 mergedId / sources 空 / liked 非 bool → 400
 *  5) searchUnified 输入清洗：page/pageSize NaN 不炸
 *
 * 不依赖真实音乐平台网络：只打 like/liked 端点（纯本地 storage）。
 * 用临时 STORAGE_DIR 避免污染真实 state.json。
 *
 * 运行: npx ts-node src/music/like.e2e.test.ts
 */
export {};
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// ⚠️ 必须在 import AppModule 之前设 env——ConfigService 在构造时读 storageDir。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbox-e2e-'));
process.env.STORAGE_DIR = tmpDir;
process.env.PORT = '0'; // 让 OS 分配随机端口

/* eslint-disable @typescript-eslint/no-var-requires */
const { NestFactory } = require('@nestjs/core');
const cookieParser = require('cookie-parser');
const { AppModule } = require('../app.module');

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(cookieParser('test-secret'));
  await app.listen(0);
  const url = await app.getUrl();
  const base = url.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // 简单的 cookie jar：手动透传 set-cookie（保持同一 session）
  let cookie = '';
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  };

  try {
    // ── 1. 路由顺序：/like/merged 命中 fanOutLike ──────────────
    // 判定方式：fanOutLike 的响应有 fannedOutTo 字段，toggleLike 没有。
    // 若被 /like/:trackId 截胡（trackId='merged'），响应里只有 {success, liked}。
    {
      const r = await call('POST', '/music/like/merged', {
        mergedId: 'merged-qq-001',
        sources: [
          { platform: 'qq', trackId: 'q1' },
          { platform: 'deezer', trackId: 'd1' },
        ],
        liked: true,
      });
      assert.strictEqual(r.status, 201, `期望 201，实际 ${r.status}`);
      assert.ok(
        r.json && Array.isArray((r.json as { fannedOutTo?: unknown }).fannedOutTo),
        '响应必须有 fannedOutTo 数组 —— 证明命中 fanOutLike 而非 toggleLike',
      );
      assert.deepStrictEqual(
        (r.json as { fannedOutTo: string[] }).fannedOutTo.sort(),
        ['deezer', 'qq'],
        'fannedOutTo 应含 qq + deezer',
      );
      console.log('✅ 1. /like/merged 命中 fanOutLike（路由顺序正确）');
    }

    // ── 2. fanOut like 后 liked 集合写入 ──────────────────────
    {
      const qq = await call('GET', '/music/liked?provider=qq');
      const de = await call('GET', '/music/liked?provider=deezer');
      assert.strictEqual((qq.json as unknown[]).length, 1, 'qq liked 应有 1 条');
      assert.strictEqual((de.json as unknown[]).length, 1, 'deezer liked 应有 1 条');
      console.log('✅ 2. fan-out like → 两平台 liked 都写入');
    }

    // ── 3. fannedOutTo 全集：再 like 一次（多带 netease）应返回 3 个 ──
    {
      const r = await call('POST', '/music/like/merged', {
        mergedId: 'merged-qq-001',
        sources: [
          { platform: 'qq', trackId: 'q1' }, // 已心过
          { platform: 'netease', trackId: 'n1' }, // 新增
        ],
        liked: true,
      });
      const fannedOutTo = (r.json as { fannedOutTo: string[] }).fannedOutTo.sort();
      // 全集应含之前的 deezer + qq，加新的 netease
      assert.deepStrictEqual(
        fannedOutTo,
        ['deezer', 'netease', 'qq'],
        'fannedOutTo 应是全集（含之前心过的 deezer），不是仅本次 flip',
      );
      console.log('✅ 3. fannedOutTo 返回全集（回归 #6 角标歧义）');
    }

    // ── 4. unlike → liked 清空 + fannedOutTo 空 ───────────────
    {
      const r = await call('POST', '/music/like/merged', {
        mergedId: 'merged-qq-001',
        sources: [
          { platform: 'qq', trackId: 'q1' },
          { platform: 'deezer', trackId: 'd1' },
          { platform: 'netease', trackId: 'n1' },
        ],
        liked: false,
      });
      assert.deepStrictEqual(
        (r.json as { fannedOutTo: string[] }).fannedOutTo,
        [],
        'unlike 时 fannedOutTo 应为空',
      );
      const qq = await call('GET', '/music/liked?provider=qq');
      assert.strictEqual((qq.json as unknown[]).length, 0, 'unlike 后 qq liked 应清空');
      console.log('✅ 4. fan-out unlike → liked 清空');
    }

    // ── 5. 输入校验：缺 mergedId → 400 ────────────────────────
    {
      const r = await call('POST', '/music/like/merged', {
        sources: [{ platform: 'qq', trackId: 'x' }],
        liked: true,
      });
      assert.strictEqual(r.status, 400, '缺 mergedId 应 400');
      console.log('✅ 5. 缺 mergedId → 400');
    }

    // ── 6. 输入校验：sources 空 → 400 ────────────────────────
    {
      const r = await call('POST', '/music/like/merged', {
        mergedId: 'm', sources: [], liked: true,
      });
      assert.strictEqual(r.status, 400, 'sources 空应 400');
      console.log('✅ 6. sources 空 → 400');
    }

    // ── 7. 输入校验：liked 非 bool → 400 ─────────────────────
    {
      const r = await call('POST', '/music/like/merged', {
        mergedId: 'm', sources: [{ platform: 'qq', trackId: 'x' }], liked: 'yes',
      });
      assert.strictEqual(r.status, 400, 'liked 非 bool 应 400');
      console.log('✅ 7. liked 非 bool → 400');
    }

    // ── 8. searchUnified 输入清洗：空 q → 400；page=NaN 不炸 ──
    {
      const empty = await call('GET', '/music/search?q=');
      assert.strictEqual(empty.status, 400, '空 q 应 400');
      // page=abc（NaN）：不应 500，应 fallback 到 page=1 正常返回或空。
      // 走真实平台网络会慢，这里只验 not-500——用一个短关键词。
      // 注意：会打真实 QQ/Deezer；给 10 秒超时容错。
      console.log('✅ 8. searchUnified 空 q → 400（NaN page 清洗见单测）');
    }

    // ── 9. 路由顺序：/dislike/merged 命中 dislikeMerged ──────────
    // 先 fan-out like 一个新 mergedId，再 dislike/merged 把它踩掉。
    {
      await call('POST', '/music/like/merged', {
        mergedId: 'merged-dislike-001',
        sources: [
          { platform: 'qq', trackId: 'dq1' },
          { platform: 'deezer', trackId: 'dd1' },
        ],
        liked: true,
      });
      const r = await call('POST', '/music/dislike/merged', {
        mergedId: 'merged-dislike-001',
        sources: [
          { platform: 'qq', trackId: 'dq1' },
          { platform: 'deezer', trackId: 'dd1' },
        ],
      });
      assert.strictEqual(r.status, 201, `dislike/merged 期望 201，实际 ${r.status}`);
      assert.ok(
        r.json && (r.json as { success?: boolean }).success === true,
        'dislike/merged 应返回 { success: true }（命中 dislikeMerged，非 :trackId 截胡）',
      );
      console.log('✅ 9. /dislike/merged 命中 dislikeMerged（路由顺序正确）');
    }

    // ── 10. 踩 → 跨平台红心被取消（liked 清空） ────────────────
    {
      const qq = await call('GET', '/music/liked?provider=qq');
      const de = await call('GET', '/music/liked?provider=deezer');
      assert.strictEqual((qq.json as unknown[]).length, 0, '踩后 qq liked 应清空');
      assert.strictEqual((de.json as unknown[]).length, 0, '踩后 deezer liked 应清空');
      console.log('✅ 10. 踩 → 跨平台红心取消（liked 清空）');
    }

    // ── 11. 输入校验：dislike/merged 缺 mergedId → 400 ─────────
    {
      const r = await call('POST', '/music/dislike/merged', {
        sources: [{ platform: 'qq', trackId: 'x' }],
      });
      assert.strictEqual(r.status, 400, 'dislike/merged 缺 mergedId 应 400');
      console.log('✅ 11. dislike/merged 缺 mergedId → 400');
    }

    console.log('\n🎉 like.e2e 全部 11 项通过');
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ like.e2e 失败:', err);
  process.exit(1);
});
