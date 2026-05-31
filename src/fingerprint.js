'use strict';
const Jimp = require('jimp');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { saveFingerprint, getFingerprints, getTaiwanDateString } = require('./sheets');

const execFileAsync = promisify(execFile);

// 感知雜湊（aHash, 64 bits）
async function computeImageHash(buffer) {
  const img = await Jimp.read(buffer);
  img.resize(8, 8).greyscale();
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, y));
      pixels.push(c.r);
    }
  }
  const avg = pixels.reduce((s, v) => s + v, 0) / pixels.length;
  return pixels.map(v => v >= avg ? '1' : '0').join('');
}

function hashSimilarity(h1, h2) {
  let diff = 0;
  const len = Math.min(h1.length, h2.length);
  for (let i = 0; i < len; i++) {
    if (h1[i] !== h2[i]) diff++;
  }
  return Math.round((1 - diff / len) * 100);
}

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function extractFirstFrame(videoBuffer) {
  let ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); } catch {
    console.warn('ffmpeg-static 未安裝，略過影片幀擷取');
    return null;
  }
  const id = Date.now();
  const tmpIn  = path.join(os.tmpdir(), `vlb_v_${id}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `vlb_f_${id}.jpg`);
  try {
    fs.writeFileSync(tmpIn, videoBuffer);
    await execFileAsync(ffmpegPath, ['-i', tmpIn, '-vframes', '1', '-q:v', '2', tmpOut]);
    return fs.readFileSync(tmpOut);
  } catch (err) {
    console.error('擷取影片幀失敗：', err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

async function processMedia(client, messageId, messageType, memberName, date) {
  try {
    const stream = await client.getMessageContent(messageId);
    const buffer = await streamToBuffer(stream);

    let hash;
    const fileType = messageType === 'image' ? '截圖' : '影片';
    const threshold = messageType === 'image' ? 85 : 80;

    if (messageType === 'image') {
      hash = await computeImageHash(buffer);
    } else {
      const frame = await extractFirstFrame(buffer);
      if (!frame) { console.log(`影片幀擷取失敗，跳過 ${memberName} 查重`); return; }
      hash = await computeImageHash(frame);
    }

    const history = await getFingerprints(fileType);
    let dup = null;
    for (const r of history) {
      if (!r[3]) continue;
      const sim = hashSimilarity(hash, r[3]);
      if (sim >= threshold) { dup = { name: r[1], date: r[0], sim }; break; }
    }

    const adminId = process.env.ADMIN_LINE_USER_ID;
    if (dup) {
      console.log(`⚠️ [查重] 疑似重複${fileType}：${memberName} 相似度 ${dup.sim}%`);
      if (adminId) {
        await client.pushMessage({
          to: adminId,
          messages: [{ type: 'text', text: `⚠️ 疑似重複${fileType}，請確認\n小編：${memberName}\n日期：${date}\n相似度：${dup.sim}%\n原始上傳：${dup.name}（${dup.date}）` }],
        });
      }
    } else {
      await saveFingerprint({ date, name: memberName, fileType, hash, driveLink: '' });
      console.log(`✅ [查重] ${fileType}已儲存：${memberName}（${date}）`);
    }
  } catch (err) {
    console.error('processMedia 失敗：', err.message);
  }
}

module.exports = { processMedia, computeImageHash, hashSimilarity };
