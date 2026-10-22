/**
 * SERVER.JS - CDEV TÀI XỈU PREDICTOR (CẤP CAO)
 * API gốc: tele68 md5 lite-sessions
 * Thuật toán: Phân tích TOÀN BỘ loại cầu + Tổng điểm + Ensemble cấp cao
 * Output JSON theo yêu cầu đại ca
 */

const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d';
const AUTHOR_ID = '@onlywhite27';

// ====================== 1. TÁCH RUNS (CẦU) ======================
function extractRuns(data) {
  const runs = [];
  let i = 0;
  while (i < data.length) {
    const type = data[i].result;
    let len = 1;
    while (i + len < data.length && data[i + len].result === type) {
      len++;
    }
    runs.push({ type, len });
    i += len;
  }
  return runs;
}

// ====================== 2. THUẬT TOÁN PHÂN TÍCH TOÀN BỘ LOẠI CẦU (CẤP CAO) ======================
function analyzeAllCau(runs, data) {
  if (runs.length < 2) return { scoreT: 0, scoreX: 0, reasons: [], detected: [] };

  const lastRun = runs[runs.length - 1];
  const prevRun = runs[runs.length - 2];
  const prev2Run = runs.length >= 3 ? runs[runs.length - 3] : null;

  const currentCau = `${prevRun.len}-${lastRun.len}`;
  const currentStreak = lastRun.len;
  const currentType = lastRun.type; // 'T' hoặc 'X'
  const opposite = currentType === 'T' ? 'X' : 'T';

  let scoreT = 0;
  let scoreX = 0;
  const reasons = [];
  const detected = [];

  // ===== BẢNG MẸO CẦU TỪ DỮ LIỆU 7156 PHIÊN =====
  const cauTable = {
    '1-1': { next: 'dao', conf: 48 },
    '1-2': { next: 'dao', conf: 50 },
    '2-1': { next: 'dao', conf: 51 },
    '2-2': { next: 'dao', conf: 45 },
    '1-3': { next: 'dao', conf: 56 },
    '3-1': { next: 'dao', conf: 47 },
    '2-3': { next: 'dao', conf: 53 },
    '3-2': { next: 'dao', conf: 49 },
    '3-3': { next: 'dao', conf: 40 },
    '1-4': { next: 'dao', conf: 45 },
    '4-1': { next: 'dao', conf: 47 },
    '4-2': { next: 'dao', conf: 45 },
    '2-4': { next: 'dao', conf: 48 },
    '5-1': { next: 'dao', conf: 50 },
    '1-5': { next: 'dao', conf: 52 },
    '3-4': { next: 'dao', conf: 48 },
    '4-3': { next: 'dao', conf: 46 },
    '2-5': { next: 'dao', conf: 50 },
    '5-2': { next: 'dao', conf: 48 },
    '1-6': { next: 'dao', conf: 52 },
    '6-1': { next: 'dao', conf: 55 },
    '4-4': { next: 'dao', conf: 50 },
    '3-5': { next: 'dao', conf: 50 },
    '5-3': { next: 'dao', conf: 48 }
  };

  // 1. Cầu cặp độ dài (1-1, 1-2, 2-2...)
  if (cauTable[currentCau]) {
    const info = cauTable[currentCau];
    detected.push(`Cầu ${currentCau}`);
    if (info.next === 'dao') {
      if (opposite === 'T') scoreT += info.conf;
      else scoreX += info.conf;
      reasons.push(`Cầu ${currentCau} → đảo (${info.conf}%)`);
    }
  } else {
    detected.push(`Cầu lạ ${currentCau}`);
    // Cầu lạ → mặc định đảo nhẹ
    if (opposite === 'T') scoreT += 42;
    else scoreX += 42;
    reasons.push(`Cầu ${currentCau} lạ → đảo nhẹ`);
  }

  // 2. Cầu 3 nhịp (triple)
  if (prev2Run) {
    const triple = `${prev2Run.len}-${prevRun.len}-${lastRun.len}`;
    detected.push(`Triple ${triple}`);
    // Pattern phổ biến từ dữ liệu
    if (triple === '1-1-1') {
      if (opposite === 'T') scoreT += 12; else scoreX += 12;
      reasons.push('Triple 1-1-1 → tiếp tục đảo');
    } else if (['1-2-1', '2-1-1', '1-1-2'].includes(triple)) {
      if (opposite === 'T') scoreT += 10; else scoreX += 10;
      reasons.push(`Triple ${triple} → nghiêng đảo`);
    } else if (triple.startsWith('1-3') || triple.startsWith('3-1')) {
      if (opposite === 'T') scoreT += 8; else scoreX += 8;
      reasons.push(`Triple ${triple} → hỗ trợ đảo`);
    }
  }

  // 3. Cầu bệt (streak dài)
  if (currentStreak >= 7) {
    detected.push(`Bệt ${currentStreak}`);
    if (opposite === 'T') scoreT += 25; else scoreX += 25;
    reasons.push(`Bệt ${currentStreak} rất dài → ưu tiên gãy mạnh`);
  } else if (currentStreak >= 5) {
    detected.push(`Bệt ${currentStreak}`);
    if (opposite === 'T') scoreT += 15; else scoreX += 15;
    reasons.push(`Bệt ${currentStreak} → nghiêng gãy`);
  } else if (currentStreak >= 4) {
    detected.push(`Streak ${currentStreak}`);
    if (opposite === 'T') scoreT += 8; else scoreX += 8;
    reasons.push(`Streak ${currentStreak} → hơi nghiêng gãy`);
  }

  // 4. Cầu đảo liên tục (nhiều 1 liên tiếp)
  let daoLienTiep = 0;
  for (let k = runs.length - 1; k >= 0; k--) {
    if (runs[k].len === 1) daoLienTiep++;
    else break;
  }
  if (daoLienTiep >= 4) {
    detected.push(`Đảo liên tục x${daoLienTiep}`);
    // Sau nhiều đảo → khả năng xuất hiện cầu 2 tăng
    if (currentType === 'T') scoreX += 8; else scoreT += 8;
    reasons.push(`Đã đảo ${daoLienTiep} lần → nghiêng xuất hiện 2`);
  }

  // 5. Cầu 2-2 / 3-3 lặp
  if (prevRun.len === lastRun.len && lastRun.len >= 2) {
    detected.push(`Cầu ${lastRun.len}-${lastRun.len}`);
    if (opposite === 'T') scoreT += 6; else scoreX += 6;
    reasons.push(`Cầu đều ${lastRun.len}-${lastRun.len} → nghiêng đảo`);
  }

  return {
    scoreT,
    scoreX,
    reasons,
    detected,
    currentCau,
    currentStreak,
    currentType: currentType === 'T' ? 'TAI' : 'XIU'
  };
}

// ====================== 3. THUẬT TOÁN TỔNG ĐIỂM ======================
function analyzeDiem(data) {
  const lastDiem = data[data.length - 1].diem;
  const last3 = data.slice(-3).map(d => d.diem);
  const last5 = data.slice(-5).map(d => d.diem);
  const avg5 = last5.reduce((a, b) => a + b, 0) / last5.length;

  let scoreT = 0;
  let scoreX = 0;
  const reasons = [];

  if (lastDiem <= 6) {
    scoreT += 18;
    reasons.push(`Điểm ${lastDiem} thấp → nghiêng TÀI`);
  } else if (lastDiem >= 15) {
    scoreX += 20;
    reasons.push(`Điểm ${lastDiem} cao → nghiêng XỈU`);
  } else if (lastDiem >= 12) {
    scoreX += 10;
    reasons.push(`Điểm ${lastDiem} khá cao → hơi nghiêng XỈU`);
  } else if (lastDiem <= 9) {
    scoreT += 10;
    reasons.push(`Điểm ${lastDiem} khá thấp → hơi nghiêng TÀI`);
  }

  const allHigh = last3.every(d => d >= 13);
  const allLow = last3.every(d => d <= 8);
  if (allHigh) {
    scoreX += 15;
    reasons.push('3 phiên điểm cao liên tiếp → XỈU');
  } else if (allLow) {
    scoreT += 15;
    reasons.push('3 phiên điểm thấp liên tiếp → TÀI');
  }

  // Trung bình 5 phiên
  if (avg5 >= 12.5) {
    scoreX += 8;
    reasons.push(`Avg5 = ${avg5.toFixed(1)} cao → XỈU`);
  } else if (avg5 <= 8.5) {
    scoreT += 8;
    reasons.push(`Avg5 = ${avg5.toFixed(1)} thấp → TÀI`);
  }

  return { scoreT, scoreX, reasons, lastDiem, avg5: Math.round(avg5 * 10) / 10 };
}

// ====================== 4. THUẬT TOÁN FREQUENCY NGẮN HẠN ======================
function analyzeFrequency(data) {
  const last10 = data.slice(-10);
  const countT = last10.filter(d => d.result === 'T').length;
  const countX = last10.length - countT;
  const pctT = (countT / last10.length) * 100;

  let scoreT = 0;
  let scoreX = 0;
  const reasons = [];

  if (pctT >= 70) {
    scoreX += 18;
    reasons.push(`10 phiên gần: TÀI ${pctT.toFixed(0)}% → hồi quy XỈU`);
  } else if (pctT <= 30) {
    scoreT += 18;
    reasons.push(`10 phiên gần: TÀI ${pctT.toFixed(0)}% → hồi quy TÀI`);
  } else if (pctT >= 60) {
    scoreX += 10;
    reasons.push(`10 phiên gần: TÀI ${pctT.toFixed(0)}% → hơi nghiêng XỈU`);
  } else if (pctT <= 40) {
    scoreT += 10;
    reasons.push(`10 phiên gần: TÀI ${pctT.toFixed(0)}% → hơi nghiêng TÀI`);
  }

  return { scoreT, scoreX, reasons, pctT: Math.round(pctT) };
}

// ====================== 5. ENSEMBLE CẤP CAO (KẾT HỢP TẤT CẢ) ======================
function analyzeCauAndDiem(history) {
  if (!Array.isArray(history) || history.length < 5) {
    return { error: 'Cần ít nhất 5 phiên để phân tích' };
  }

  const data = history.map(h => ({
    result: (h.result || h.resultTruyenThong || '').toUpperCase() === 'TAI' ? 'T' : 'X',
    diem: Number(h.diem || h.point || 0)
  }));

  const runs = extractRuns(data);
  if (runs.length < 2) {
    return { error: 'Chưa đủ cầu để phân tích' };
  }

  // Chạy 3 thuật toán
  const cauResult = analyzeAllCau(runs, data);
  const diemResult = analyzeDiem(data);
  const freqResult = analyzeFrequency(data);

  // Tổng điểm số (trọng số: Cầu 50% | Điểm 30% | Frequency 20%)
  const totalT = cauResult.scoreT * 0.5 + diemResult.scoreT * 0.3 + freqResult.scoreT * 0.2;
  const totalX = cauResult.scoreX * 0.5 + diemResult.scoreX * 0.3 + freqResult.scoreX * 0.2;

  let prediction, confidence;
  if (totalT > totalX) {
    prediction = 'TAI';
    confidence = Math.min(88, Math.round(50 + (totalT - totalX)));
  } else {
    prediction = 'XIU';
    confidence = Math.min(88, Math.round(50 + (totalX - totalT)));
  }

  // Lý do tổng hợp
  const allReasons = [
    ...cauResult.reasons,
    ...diemResult.reasons,
    ...freqResult.reasons
  ];

  return {
    prediction,
    confidence,
    reason: allReasons.slice(0, 4).join(' | '),
    currentCau: cauResult.currentCau,
    currentStreak: cauResult.currentStreak,
    currentType: cauResult.currentType,
    lastDiem: diemResult.lastDiem,
    detectedCau: cauResult.detected,
    scoreDetail: {
      T: Math.round(totalT),
      X: Math.round(totalX)
    }
  };
}

// ====================== FETCH API GỐC ======================
function fetchApi() {
  return new Promise((resolve, reject) => {
    https.get(API_URL, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve(json);
        } catch (e) {
          reject(new Error('Parse JSON fail: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

// ====================== ROUTE CHÍNH ======================
app.get('/', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];

    if (list.length < 5) {
      return res.json({
        id: AUTHOR_ID,
        error: 'API trả về ít hơn 5 phiên, không đủ phân tích'
      });
    }

    const newest = list[0];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong,
      diem: item.point,
      id: item.id,
      dices: item.dices
    }));

    const analysis = analyzeCauAndDiem(history);

    if (analysis.error) {
      return res.json({
        id: AUTHOR_ID,
        error: analysis.error
      });
    }

    const phienNay = newest.id + 1;

    const output = {
      id: AUTHOR_ID,
      phien_truoc: newest.id,
      xuc_xac: newest.dices || [],
      ket_qua: newest.resultTruyenThong,
      phien_nay: phienNay,
      du_doan: analysis.prediction,
      do_tin_cay: analysis.confidence + '%'
    };

    res.json(output);
  } catch (err) {
    res.status(500).json({
      id: AUTHOR_ID,
      error: err.message
    });
  }
});

// Route debug (xem full analysis cấp cao)

// ====================== ROUTE MD5 THEO YÊU CẦU ======================
app.get('/api/taixiumd5/lc79', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];

    if (list.length < 5) {
      return res.json({
        id: AUTHOR_ID,
        error: 'API trả về ít hơn 5 phiên, không đủ phân tích'
      });
    }

    const newest = list[0];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong,
      diem: item.point,
      id: item.id,
      dices: item.dices
    }));

    const analysis = analyzeCauAndDiem(history);

    if (analysis.error) {
      return res.json({
        id: AUTHOR_ID,
        error: analysis.error
      });
    }

    const phienNay = newest.id + 1;

    const output = {
      id: AUTHOR_ID,
      phien_truoc: newest.id,
      xuc_xac: newest.dices || [],
      ket_qua: newest.resultTruyenThong,
      phien_nay: phienNay,
      du_doan: analysis.prediction,
      do_tin_cay: analysis.confidence + '%'
    };

    res.json(output);
  } catch (err) {
    res.status(500).json({
      id: AUTHOR_ID,
      error: err.message
    });
  }
});

app.get('/debug', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong,
      diem: item.point,
      id: item.id,
      dices: item.dices
    }));
    const analysis = analyzeCauAndDiem(history);
    res.json({
      id: AUTHOR_ID,
      newest: list[0],
      analysis,
      history_len: history.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 CDEV Server CẤP CAO chạy tại http://localhost:${PORT}`);
  console.log(`   GET /                  → JSON dự đoán`);
  console.log(`   GET /api/taixiumd5/lc79 → JSON dự đoán (route chính)`);
  console.log(`   GET /debug             → full analysis (cầu + điểm + frequency)`);
});
