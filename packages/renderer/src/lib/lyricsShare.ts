import { API_ORIGIN } from '../api';
import type { LyricLine } from '../api';

const WIDTH = 720;
const PADDING = 48;
const COVER_SIZE = 112;
const LINE_HEIGHT = 34;
const MAX_LINES = 40;

/**
 * 把歌词渲染成一张可分享的图片（cover + 歌名/歌手 + 歌词正文），
 * 生成 PNG 并触发本地下载。cover 走 /music/cover-proxy（带 CORS 头），
 * 否则 canvas 会被跨域图片污染、toDataURL 直接 throw。
 *
 * 返回 true 表示已触发下载；封面加载失败会降级成无封面版式，仍会导出。
 */
export async function downloadLyricsImage(opts: {
  title: string;
  artist: string;
  coverUrl: string;
  lines: LyricLine[];
}): Promise<boolean> {
  const { title, artist, coverUrl } = opts;
  const lines = opts.lines.slice(0, MAX_LINES);
  const truncated = opts.lines.length > MAX_LINES;

  let cover: ImageBitmap | null = null;
  if (coverUrl) {
    try {
      const proxied = `${API_ORIGIN}/music/cover-proxy?url=${encodeURIComponent(coverUrl)}`;
      const res = await fetch(proxied);
      if (res.ok) cover = await createImageBitmap(await res.blob());
    } catch {
      cover = null;
    }
  }

  const headerH = PADDING + COVER_SIZE + 28;
  const bodyH = (lines.length + (truncated ? 1 : 0)) * LINE_HEIGHT;
  const footerH = 64;
  const height = headerH + bodyH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  // 暖奶白底 + 顶部一条 accent 色带，和 App 的暖色调一致
  ctx.fillStyle = '#faf6f0';
  ctx.fillRect(0, 0, WIDTH, height);
  const grad = ctx.createLinearGradient(0, 0, WIDTH, 0);
  grad.addColorStop(0, '#eb9e76');
  grad.addColorStop(1, '#a2472a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, 6);

  // cover（圆角裁剪）
  if (cover) {
    ctx.save();
    const r = 16;
    const x = PADDING;
    const y = PADDING;
    ctx.beginPath();
    ctx.roundRect(x, y, COVER_SIZE, COVER_SIZE, r);
    ctx.clip();
    ctx.drawImage(cover, x, y, COVER_SIZE, COVER_SIZE);
    ctx.restore();
  }

  // 歌名 / 歌手
  const textX = cover ? PADDING + COVER_SIZE + 24 : PADDING;
  ctx.fillStyle = '#2b2119';
  ctx.font =
    '600 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(title, textX, PADDING + 44, WIDTH - textX - PADDING);
  ctx.fillStyle = '#8a7361';
  ctx.font =
    '400 18px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(artist, textX, PADDING + 76, WIDTH - textX - PADDING);

  // 歌词正文
  ctx.fillStyle = '#453629';
  ctx.font =
    '400 19px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  let y = headerH + LINE_HEIGHT;
  for (const line of lines) {
    ctx.fillText(line.text, PADDING, y, WIDTH - PADDING * 2);
    y += LINE_HEIGHT;
  }
  if (truncated) {
    ctx.fillStyle = '#a08c7a';
    ctx.fillText('…', PADDING, y);
  }

  // 落款
  ctx.fillStyle = '#b7a390';
  ctx.font =
    '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('Maestro', PADDING, height - 28);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${title} - ${artist} 歌词.png`.replace(/[/\\:*?"<>|]/g, '_');
  a.click();
  return true;
}
