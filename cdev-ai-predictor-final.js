/**
 * CDEV AI SUITE - ALL-IN-ONE TÀI/XỈU ANALYTICS
 *
 * Một file duy nhất gồm: chuẩn hóa dữ liệu; Bayesian/Markov/streak/pattern;
 * tổng hợp cầu; 45 tín hiệu mở rộng; walk-forward tuning; Bayesian Model
 * Averaging; calibration; uncertainty interval; API tương thích server gốc.
 *
 * Nguyên tắc: không ép dự đoán khi edge không đủ lớn. Confidence là xác suất
 * đã hiệu chỉnh, không phải lời đảm bảo thắng.
 */

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = process.env.API_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d';
const AUTHOR_ID = '@onlywhite27';
const LEDGER_FILE = process.env.PREDICTION_LEDGER || path.join(__dirname, 'prediction-ledger.json');

function readLedger() {
  try {
    const value = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function writeLedger(rows) {
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows.slice(-5000), null, 2));
  fs.renameSync(tmp, LEDGER_FILE);
}

function reconcileLedger(ledger, actualSession, actualResult) {
  let changed = false;
  for (const row of ledger) {
    if (String(row.targetSession) !== String(actualSession) || row.actual) continue;
    row.actual = actualResult;
    row.correct = row.prediction === actualResult;
    row.settledAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}

function appendPrediction(ledger, row) {
  const exists = ledger.some(x => String(x.targetSession) === String(row.targetSession));
  if (!exists) ledger.push(row);
  writeLedger(ledger);
}

function ledgerMetrics(ledger) {
  const settled = ledger.filter(x => (x.actual === 'TAI' || x.actual === 'XIU') &&
    (x.prediction === 'TAI' || x.prediction === 'XIU'));
  if (!settled.length) return { settled: 0, accuracy: null, logLoss: null, brier: null };
  let correct = 0, loss = 0, brier = 0;
  for (const row of settled) {
    const p = clamp(Number(row.probabilityTai) || 0.5);
    const y = row.actual === 'TAI' ? 1 : 0;
    if (row.prediction === row.actual) correct++;
    loss += y ? -Math.log(p) : -Math.log(1 - p);
    brier += (p - y) ** 2;
  }
  return {
    settled: settled.length,
    accuracy: Number((correct / settled.length).toFixed(4)),
    logLoss: Number((loss / settled.length).toFixed(4)),
    brier: Number((brier / settled.length).toFixed(4)),
    pending: ledger.length - settled.length
  };
}

// Hiệu chỉnh online theo dự đoán live đã settle. Mẫu ít được shrink về prior.
function calibrateWithLedger(probabilityTai, ledger) {
  const settled = ledger.filter(x => (x.actual === 'TAI' || x.actual === 'XIU') &&
    Number.isFinite(Number(x.probabilityTai)));
  const nearby = settled.filter(x => Math.abs(Number(x.probabilityTai) - probabilityTai) <= 0.10);
  if (nearby.length < 8) return { probabilityTai, support: nearby.length, applied: false };
  const observed = (nearby.filter(x => x.actual === 'TAI').length + 2) / (nearby.length + 4);
  const blend = Math.min(0.45, nearby.length / 80);
  return {
    probabilityTai: clamp(probabilityTai * (1 - blend) + observed * blend),
    support: nearby.length,
    applied: true
  };
}

// Dữ liệu MD5X3 người dùng cung cấp. Đây là prior bổ sung, không thay thế API live.
const MANUAL_MD5X3 = [
  ['XỈU', 70], ['TÀI', 60], ['TÀI', 70], ['XỈU', 60],
  ['TÀI', 80], ['XỈU', 80], ['XỈU', 70], ['TÀI', 80],
  ['XỈU', 60], ['TÀI', 80], ['TÀI', 80], ['XỈU', 60],
  ['XỈU', 70], ['TÀI', 60], ['XỈU', 60], ['XỈU', 80]
].map(([result, confidence], index) => ({
  result: result === 'TÀI' ? 'T' : 'X',
  confidence,
  index
}));

function toTX(h) {
  const raw = String(h.result || h.resultTruyenThong || '').toUpperCase();
  return {
    id: h.id ?? h._id ?? null,
    result: raw === 'TAI' || raw === 'T' ? 'T' : raw === 'XIU' || raw === 'X' ? 'X' : null,
    diem: Number(h.diem || h.point || 0),
    dices: h.dices || null
  };
}

function dataQuality(data) {
  const valid = data.filter(x => x.result === 'T' || x.result === 'X').length;
  const ids = data.map(x => x.id).filter(Boolean);
  const duplicateIds = ids.length - new Set(ids).size;
  const pointMismatches = data.filter(x => Array.isArray(x.dices) && x.dices.length === 3 &&
    x.dices.every(Number.isFinite) && x.diem !== x.dices.reduce((a, b) => a + b, 0)).length;
  return {
    samples: data.length,
    invalidResults: data.length - valid,
    validRate: data.length ? Number((valid / data.length).toFixed(4)) : 0,
    duplicateIds,
    pointMismatches,
    usable: data.length >= 12 && valid === data.length && duplicateIds === 0
  };
}

function extractRuns(data) {
  const runs = [];
  let i = 0;
  while (i < data.length) {
    const type = data[i].result;
    let len = 1;
    while (i + len < data.length && data[i + len].result === type) len++;
    runs.push({ type, len });
    i += len;
  }
  return runs;
}

function clamp(v, lo = 0.001, hi = 0.999) {
  return Math.max(lo, Math.min(hi, v));
}

function recentRate(data, n) {
  const a = data.slice(Math.max(0, data.length - n));
  const t = a.filter(x => x.result === 'T').length;
  return (t + 2) / (a.length + 4);
}

// 1. Bayesian Recency với Beta prior và trọng số giảm dần
function algoBayesian(data) {
  let t = 2, x = 2;
  for (let i = 0; i < data.length; i++) {
    const weight = Math.pow(0.96, data.length - 1 - i);
    if (data[i].result === 'T') t += weight; else x += weight;
  }
  const pT = t / (t + x);
  return { pT, scoreT: Math.max(0, (pT - 0.5) * 100), scoreX: Math.max(0, (0.5 - pT) * 100), name: 'BayesianRecency' };
}

// 2. Markov bậc 1-3, smoothing để không bị 0/1 do mẫu nhỏ
function markovProbability(data, order) {
  const seq = data.map(d => d.result);
  if (seq.length <= order) return 0.5;
  const key = seq.slice(-order).join('');
  let t = 2, x = 2;
  for (let i = order; i < seq.length; i++) {
    if (seq.slice(i - order, i).join('') !== key) continue;
    if (seq[i] === 'T') t++; else x++;
  }
  return t / (t + x);
}

function algoMonteCarlo(data) {
  const p = (markovProbability(data, 1) + markovProbability(data, 2) + markovProbability(data, 3)) / 3;
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 120), scoreX: Math.max(0, (0.5 - p) * 120), name: 'MarkovEnsemble' };
}

// 3. Xác suất sau streak tương tự trong lịch sử
function algoRunLength(runs, data) {
  if (!runs.length) return { pT: 0.5, scoreT: 0, scoreX: 0, name: 'RunLength' };
  const current = runs[runs.length - 1];
  let t = 2, x = 2;
  for (let i = 0; i < runs.length - 1; i++) {
    const r = runs[i];
    if (r.type !== current.type || Math.abs(r.len - current.len) > 1) continue;
    const next = runs[i + 1].type;
    if (next === 'T') t++; else x++;
  }
  const p = t / (t + x);
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 100), scoreX: Math.max(0, (0.5 - p) * 100), name: 'RunLengthConditional' };
}

// 4. Pattern matching hậu tố chuỗi
function algoEntropy(data) {
  const seq = data.map(d => d.result);
  let t = 2, x = 2;
  for (let order = 1; order <= 4; order++) {
    if (seq.length <= order) continue;
    const key = seq.slice(-order).join('');
    for (let i = order; i < seq.length - 1; i++) {
      if (seq.slice(i - order, i).join('') !== key) continue;
      if (seq[i] === 'T') t += order / 4; else x += order / 4;
    }
  }
  const p = t / (t + x);
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 110), scoreX: Math.max(0, (0.5 - p) * 110), name: 'SuffixPattern' };
}

// 5. Weighted Moving Probability
function algoWeightedMoving(data) {
  let t = 0, total = 0;
  const start = Math.max(0, data.length - 24);
  for (let i = start; i < data.length; i++) {
    const weight = Math.exp((i - data.length + 1) / 8);
    total += weight;
    if (data[i].result === 'T') t += weight;
  }
  const p = total ? (t + 2) / (total + 4) : 0.5;
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 100), scoreX: Math.max(0, (0.5 - p) * 100), name: 'WeightedMoving' };
}

// 6. Cầu + Markov: chỉ dùng như một tín hiệu nhỏ, không mặc định cầu sẽ gãy
function algoCauMarkov(data, runs) {
  const pMarkov = markovProbability(data, 1);
  const last = runs[runs.length - 1];
  let p = pMarkov;
  if (last && last.len >= 3) {
    const opposite = last.type === 'T' ? 0 : 1;
    p = pMarkov * 0.7 + opposite * 0.3;
  }
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 80), scoreX: Math.max(0, (0.5 - p) * 80), name: 'CauMarkov' };
}

function algoDiem(data) {
  const last = data[data.length - 1];
  if (!last || !Number.isFinite(last.diem)) return { pT: 0.5, scoreT: 0, scoreX: 0, name: 'Diem' };
  const similar = data.slice(-120).filter(x => Math.abs(x.diem - last.diem) <= 1);
  if (similar.length < 6) return { pT: 0.5, scoreT: 0, scoreX: 0, name: 'Diem' };
  const p = (similar.filter(x => x.result === 'T').length + 2) / (similar.length + 4);
  return { pT: p, scoreT: Math.max(0, (p - 0.5) * 80), scoreX: Math.max(0, (0.5 - p) * 80), name: 'Diem' };
}

// 8. Tín hiệu MD5X3 thủ công: confidence chỉ là trọng số, không được coi là accuracy.
function algoManualMD5X3(rows) {
  if (!rows || !rows.length) return { pT: 0.5, scoreT: 0, scoreX: 0, name: 'ManualMD5X3' };
  let t = 2, x = 2;
  const n = rows.length;
  for (const row of rows) {
    const recency = Math.exp((row.index - n + 1) / 5);
    const confidenceWeight = 0.5 + Number(row.confidence || 50) / 200;
    const weight = recency * confidenceWeight;
    if (row.result === 'T') t += weight; else x += weight;
  }
  const p = t / (t + x);
  return {
    pT: p,
    scoreT: Math.max(0, (p - 0.5) * 120),
    scoreX: Math.max(0, (0.5 - p) * 120),
    name: 'ManualMD5X3'
  };
}

// 9. Tổng hợp cầu bệt, 1-1, 2-2/3-3, cầu lặp và cầu xu hướng.
function algoAllCau(data, runs) {
  const seq = data.map(d => d.result);
  const signals = [];

  // Cầu 1-1 / zigzag: chỉ kích hoạt khi phần đuôi thực sự luân phiên.
  if (seq.length >= 5) {
    let changes = 0;
    for (let i = Math.max(1, seq.length - 8); i < seq.length; i++) {
      if (seq[i] !== seq[i - 1]) changes++;
    }
    if (changes >= 5) {
      signals.push({ p: seq[seq.length - 1] === 'T' ? 0.35 : 0.65, w: 0.7, name: 'Cau1-1' });
    }
  }

  // Cầu bệt: học kết quả sau các streak tương tự, không ép gãy cầu.
  const current = runs[runs.length - 1];
  if (current) {
    let t = 1, x = 1, support = 0;
    for (let i = 0; i < runs.length - 1; i++) {
      const r = runs[i];
      if (r.type !== current.type || Math.abs(r.len - current.len) > 1) continue;
      support++;
      if (runs[i + 1].type === 'T') t++; else x++;
    }
    if (support >= 2) signals.push({ p: t / (t + x), w: Math.min(1.2, 0.35 + support * 0.12), name: 'CauBet' });
  }

  // Cầu 2-2 / 3-3 theo độ dài các block gần nhất.
  for (const blockSize of [2, 3]) {
    const tail = runs.slice(-4);
    if (tail.length === 4 && tail.every(r => r.len === blockSize)) {
      signals.push({ p: tail[3].type === 'T' ? 0 : 1, w: 0.75, name: `Cau${blockSize}-${blockSize}` });
      break;
    }
  }

  // Cầu lặp chu kỳ 2-4: chỉ tính khi hậu tố đã lặp ít nhất hai lần.
  for (const period of [2, 3, 4]) {
    if (seq.length < period * 3) continue;
    const pattern = seq.slice(-period).join('');
    let matches = 0;
    for (let i = period; i <= seq.length - period; i++) {
      if (seq.slice(i - period, i).join('') === pattern) matches++;
    }
    if (matches >= 2) {
      const next = seq[seq.length - period + ((matches + period - 1) % period)];
      signals.push({ p: next === 'T' ? 1 : 0, w: Math.min(1, matches * 0.25), name: `CauLap${period}` });
    }
  }

  // Cầu xu hướng là tín hiệu yếu, chỉ dùng khi cửa sổ ngắn và dài cùng hướng.
  const p5 = recentRate(data, 5);
  const p10 = recentRate(data, 10);
  if ((p5 - 0.5) * (p10 - 0.5) > 0.01) {
    signals.push({ p: (p5 + p10) / 2, w: 0.45, name: 'CauXuHuong' });
  }

  if (!signals.length) return { pT: 0.5, scoreT: 0, scoreX: 0, name: 'AllCau', detail: 'none' };
  const totalWeight = signals.reduce((s, x) => s + x.w, 0);
  const p = signals.reduce((s, x) => s + x.p * x.w, 0) / totalWeight;
  return {
    pT: p,
    scoreT: Math.max(0, (p - 0.5) * 120),
    scoreX: Math.max(0, (0.5 - p) * 120),
    name: 'AllCau',
    detail: signals.map(x => x.name).join(',')
  };
}

// 10. Gói 45 tín hiệu: 15 xác suất, 10 nâng cao, 5 kiểm tra dữ liệu/mẹo,
// và 15 tín hiệu AI-style. Đây là các mô hình thống kê tái lập, không gọi API AI.
function algoMegaPack(data, runs) {
  const seq = data.map(x => x.result);
  const p5 = recentRate(data, 5), p10 = recentRate(data, 10), p24 = recentRate(data, 24);
  const p60 = recentRate(data, 60);
  const m1 = markovProbability(data, 1), m2 = markovProbability(data, 2), m3 = markovProbability(data, 3);
  const last = runs[runs.length - 1] || { type: 'T', len: 1 };
  const add = (name, group, p, weight) => ({ name, group, pT: clamp(p), weight });
  const out = [];

  // 15 thuật toán xác suất nền.
  out.push(add('Prob-BetaGlobal', 'probability', (seq.filter(x => x === 'T').length + 2) / (seq.length + 4), 0.80));
  out.push(add('Prob-BetaRecent', 'probability', (data.slice(-20).filter(x => x.result === 'T').length + 2) / (Math.min(20, data.length) + 4), 0.85));
  out.push(add('Prob-EWMA5', 'probability', p5, 0.75));
  out.push(add('Prob-EWMA10', 'probability', p10, 0.80));
  out.push(add('Prob-Window24', 'probability', p24, 0.75));
  out.push(add('Prob-Window60', 'probability', p60, 0.60));
  out.push(add('Prob-Markov1', 'probability', m1, 0.90));
  out.push(add('Prob-Markov2', 'probability', m2, 0.85));
  out.push(add('Prob-Markov3', 'probability', m3, 0.75));
  out.push(add('Prob-TransitionDecay', 'probability', (m1 * 0.5 + m2 * 0.3 + m3 * 0.2), 0.80));
  out.push(add('Prob-RunHazard', 'probability', last.type === 'T' ? 0.5 + (last.len < 3 ? 0.03 : -0.02) : 0.5 - (last.len < 3 ? 0.03 : -0.02), 0.45));
  out.push(add('Prob-Suffix1', 'probability', m1, 0.65));
  out.push(add('Prob-Suffix2', 'probability', m2, 0.65));
  out.push(add('Prob-PointSimilarity', 'probability', algoDiem(data).pT, 0.55));
  out.push(add('Prob-EntropyBalance', 'probability', (p5 + p10 + p24) / 3, 0.45));

  // 10 thuật toán nâng cao toàn diện.
  const regime = p5 > 0.58 && p10 > 0.55 ? 0.55 : p5 < 0.42 && p10 < 0.45 ? 0.45 : 0.5;
  const slope = 0.5 + (p5 - p24) * 0.35;
  const robust = 0.5 + ((m1 - 0.5) * 0.45 + (p24 - 0.5) * 0.35);
  const bagged = (p5 * 0.35 + p10 * 0.30 + p24 * 0.20 + p60 * 0.15);
  const pattern = algoEntropy(data).pT;
  out.push(add('Advanced-HMMRegime', 'advanced', regime, 0.70));
  out.push(add('Advanced-ChangePoint', 'advanced', slope, 0.60));
  out.push(add('Advanced-LogisticProxy', 'advanced', 0.5 + (m1 - 0.5) * 0.55 + (p10 - 0.5) * 0.25, 0.80));
  out.push(add('Advanced-RidgeProxy', 'advanced', 0.5 + (m2 - 0.5) * 0.45 + (p24 - 0.5) * 0.25, 0.70));
  out.push(add('Advanced-BaggedWindows', 'advanced', bagged, 0.75));
  out.push(add('Advanced-KNNPattern', 'advanced', pattern, 0.60));
  out.push(add('Advanced-KalmanRate', 'advanced', p5 * 0.65 + p10 * 0.35, 0.65));
  out.push(add('Advanced-Stacking', 'advanced', (m1 + m2 + p10 + p24) / 4, 0.75));
  out.push(add('Advanced-MixtureExperts', 'advanced', robust, 0.70));
  out.push(add('Advanced-ConformalShrink', 'advanced', 0.5 + (bagged - 0.5) * 0.65, 0.60));

  // 5 thuật toán kiểm tra dữ liệu/mẹo. Chúng không tự tạo bias; chỉ giảm trọng số.
  const unique = new Set(seq).size / 2;
  const quality = Math.min(1, data.length / 60) * (unique > 0.5 ? 1 : 0.7);
  const support = Math.min(1, runs.length / 12);
  out.push(add('Data-QualityGuard', 'data', 0.5 + (p24 - 0.5) * quality, 0.25 * quality));
  out.push(add('Data-Freshness', 'data', p5, 0.20 * Math.min(1, data.length / 30)));
  out.push(add('Data-DuplicateGuard', 'data', p10, 0.18 * quality));
  out.push(add('Data-OutlierGuard', 'data', robust, 0.18 * quality));
  out.push(add('Data-NoiseFilter', 'data', bagged, 0.22 * support));

  // 15 AI-style analyzers: các bộ phân tích độc lập, nhẹ và tái lập.
  const recent = data.slice(-8);
  const recentAlt = recent.length > 1 ? recent.slice(1).filter((x, i) => x.result !== recent[i].result).length / (recent.length - 1) : 0.5;
  const aiConsensus = (m1 + m2 + p5 + p10 + p24) / 5;
  out.push(add('AI-Percentile', 'ai', p10, 0.55));
  out.push(add('AI-Consensus', 'ai', aiConsensus, 0.80));
  out.push(add('AI-Disagreement', 'ai', (m1 + (1 - m2) + p5) / 3, 0.35));
  out.push(add('AI-Drift', 'ai', slope, 0.45));
  out.push(add('AI-Anomaly', 'ai', robust, 0.40));
  out.push(add('AI-Calibration', 'ai', 0.5 + (aiConsensus - 0.5) * 0.75, 0.60));
  out.push(add('AI-BootstrapProxy', 'ai', (p5 + p10 + p24 + p60) / 4, 0.55));
  out.push(add('AI-BiasVariance', 'ai', 0.5 + (p5 - p60) * 0.25, 0.35));
  out.push(add('AI-NGram', 'ai', pattern, 0.60));
  out.push(add('AI-OnlineUpdate', 'ai', 0.5 + (m1 - 0.5) * 0.80, 0.70));
  out.push(add('AI-RegimeSwitch', 'ai', regime, 0.45));
  out.push(add('AI-SignalFusion', 'ai', (aiConsensus + robust) / 2, 0.75));
  out.push(add('AI-ConfidenceGate', 'ai', 0.5 + (aiConsensus - 0.5) * Math.min(0.8, support), 0.45));
  out.push(add('AI-RecencyAttention', 'ai', p5 * 0.7 + p10 * 0.3, 0.65));
  out.push(add('AI-ContrarianCheck', 'ai', recentAlt > 0.65 ? 1 - p5 : p5, 0.30));

  return out;
}

function buildSignals(data) {
  const runs = extractRuns(data);
  return [
    algoBayesian(data),
    algoMonteCarlo(data),
    algoRunLength(runs, data),
    algoEntropy(data),
    algoWeightedMoving(data),
    algoCauMarkov(data, runs),
    algoDiem(data),
    algoManualMD5X3(MANUAL_MD5X3),
    algoAllCau(data, runs),
    ...algoMegaPack(data, runs)
  ];
}

// Tự chấm từng tín hiệu trên các phiên quá khứ, chỉ nhìn dữ liệu trước phiên đó.
function tuneSignalWeights(data, results) {
  const stats = new Map();
  for (let i = 10; i < data.length; i++) {
    const actual = data[i].result === 'T' ? 1 : 0;
    for (const signal of buildSignals(data.slice(0, i))) {
      if (!stats.has(signal.name)) stats.set(signal.name, { loss: 0, n: 0 });
      const s = stats.get(signal.name);
      const p = clamp(signal.pT);
      s.loss += actual ? -Math.log(p) : -Math.log(1 - p);
      s.n++;
    }
  }
  for (const r of results) {
    const s = stats.get(r.name);
    if (!s || s.n < 5) {
      r.weight = (r.weight || 0.5) * 0.55;
      continue;
    }
    const avgLoss = s.loss / s.n;
    const relative = Math.max(-0.75, Math.min(0.75, (Math.log(2) - avgLoss) * 4));
    r.weight = (r.weight || 0.5) * Math.exp(relative);
    r.tunedLogLoss = Number(avgLoss.toFixed(4));
    r.tunedSamples = s.n;
  }
  return results;
}

// 10. Xác suất cấp cao: Bayesian Model Averaging + uncertainty.
function highLevelProbability(results, dataLength) {
  const reliability = {
    BayesianRecency: 1.25,
    MarkovEnsemble: 1.15,
    RunLengthConditional: 0.80,
    SuffixPattern: 0.80,
    WeightedMoving: 1.00,
    CauMarkov: 0.65,
    Diem: 0.55,
    ManualMD5X3: 0.85,
    AllCau: 0.90
  };
  let weightedP = 0;
  let totalWeight = 0;
  let agreeT = 0;
  let agreeX = 0;
  for (const r of results) {
    const w = Number.isFinite(r.weight) ? r.weight : (reliability[r.name] || 0.5);
    weightedP += clamp(r.pT) * w;
    totalWeight += w;
    if (r.pT >= 0.55) agreeT += w;
    else if (r.pT <= 0.45) agreeX += w;
  }
  const rawP = totalWeight ? weightedP / totalWeight : 0.5;
  const agreement = Math.max(agreeT, agreeX) / Math.max(0.001, totalWeight);

  // Bayesian shrink: mẫu nhỏ và đồng thuận thấp sẽ bị kéo về 50%.
  const effectiveN = Math.max(4, Math.min(120, dataLength * (0.45 + agreement)));
  const alpha = 2 + rawP * effectiveN;
  const beta = 2 + (1 - rawP) * effectiveN;
  const posteriorP = alpha / (alpha + beta);
  const shrink = Math.min(0.82, Math.max(0.22, (dataLength / 100) * (0.65 + agreement)));
  const calibratedP = 0.5 + (posteriorP - 0.5) * shrink;

  // Khoảng bất định xấp xỉ 95% cho posterior Beta.
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const margin = Math.min(0.49, 1.96 * Math.sqrt(variance));
  const low = clamp(calibratedP - margin, 0, 1);
  const high = clamp(calibratedP + margin, 0, 1);
  const edge = Math.abs(calibratedP - 0.5);
  const confidence = Math.min(90, Math.round(50 + edge * 100 * (0.7 + agreement * 0.3)));

  return {
    pT: calibratedP,
    low,
    high,
    agreement,
    effectiveN,
    confidence,
    direction: calibratedP >= 0.5 ? 'TAI' : 'XIU'
  };
}

// 7. AI Ensemble có trọng số ổn định và calibration
function aiEnsemble(results, dataLength) {
  const weights = {
    BayesianRecency: 1.25,
    MarkovEnsemble: 1.15,
    RunLengthConditional: 0.80,
    SuffixPattern: 0.80,
    WeightedMoving: 1.00,
    CauMarkov: 0.65,
    Diem: 0.55,
    ManualMD5X3: 0.85,
    AllCau: 0.90
  };
  const details = [];
  for (const r of results) {
    const weight = Number.isFinite(r.weight) ? r.weight : (weights[r.name] || 0.5);
    if (Math.abs(r.pT - 0.5) >= 0.05) details.push(`${r.name}:${r.pT >= 0.5 ? 'T' : 'X'}${Math.round(Math.abs(r.pT - 0.5) * 100)}`);
  }
  const probability = highLevelProbability(results, dataLength);
  const diff = Math.abs(probability.pT - 0.5);
  const prediction = probability.direction;
  return {
    prediction,
    confidence: diff < 0.05 ? Math.min(probability.confidence, 52) : probability.confidence,
    probabilityT: probability.pT,
    totalT: Math.round(probability.pT * 100),
    totalX: Math.round((1 - probability.pT) * 100),
    intervalT: [Number(probability.low.toFixed(4)), Number(probability.high.toFixed(4))],
    agreement: Number(probability.agreement.toFixed(4)),
    effectiveN: Number(probability.effectiveN.toFixed(1)),
    details: details.join(', '),
    weakSignal: diff < 0.05
  };
}

function signalDiagnostics(results) {
  return results.map(r => ({
    name: r.name,
    group: r.group || 'core',
    probabilityT: Number(clamp(r.pT).toFixed(4)),
    weight: Number((r.weight || 0).toFixed(4)),
    tunedLogLoss: r.tunedLogLoss ?? null,
    tunedSamples: r.tunedSamples ?? 0,
    status: r.tunedLogLoss == null ? 'LOW_SUPPORT' :
      (r.tunedLogLoss < Math.log(2) ? 'KEEP' : 'DOWNWEIGHT')
  })).sort((a, b) => b.weight - a.weight);
}

function analyzeCauAndDiem(history) {
  if (!Array.isArray(history) || history.length < 12) return { error: 'Cần ít nhất 12 phiên cho AI V5' };
  const parsed = history.map(toTX);
  const data = parsed.filter(x => x.result);
  if (data.length < 12) return { error: 'Không đủ phiên hợp lệ sau khi lọc dữ liệu lỗi' };
  const results = tuneSignalWeights(data, buildSignals(data));
  const ai = aiEnsemble(results, data.length);
  const onlineCalibration = calibrateWithLedger(ai.probabilityT, readLedger());
  if (onlineCalibration.applied) {
    ai.probabilityT = onlineCalibration.probabilityTai;
    ai.totalT = Math.round(ai.probabilityT * 100);
    ai.totalX = Math.round((1 - ai.probabilityT) * 100);
    ai.prediction = ai.probabilityT >= 0.5 ? 'TAI' : 'XIU';
    ai.weakSignal = Math.abs(ai.probabilityT - 0.5) < 0.05;
    ai.confidence = ai.weakSignal ? Math.min(ai.confidence, 52) :
      Math.min(90, Math.round(50 + Math.abs(ai.probabilityT - 0.5) * 100));
    ai.calibrationSupport = onlineCalibration.support;
  }
  const quality = dataQuality(parsed);
  return {
    prediction: ai.prediction,
    confidence: ai.confidence,
    reason: `AI Suite 6 | Tài ${ai.totalT}% Xỉu ${ai.totalX}% | ${ai.details || 'Tín hiệu yếu'}`,
    scoreDetail: { TAI: ai.totalT, XIU: ai.totalX },
    probabilityInterval: ai.intervalT,
    agreement: ai.agreement,
    effectiveN: ai.effectiveN,
    onlineCalibration: {
      applied: onlineCalibration.applied,
      support: onlineCalibration.support
    },
    weakSignal: ai.weakSignal,
    quality,
    signalDiagnostics: signalDiagnostics(results)
  };
}

// Đánh giá tuần tự từng phiên cũ. Phiên i chỉ được dự đoán bằng các phiên trước i,
// tuyệt đối không dùng chính kết quả của phiên i để tạo dự đoán.
function historicalResults(history, minHistory = 12) {
  const parsed = history.map(toTX);
  const rows = [];
  for (let i = 0; i < parsed.length; i++) {
    const actual = parsed[i].result === 'T' ? 'TAI' : parsed[i].result === 'X' ? 'XIU' : null;
    if (i < minHistory || !actual) {
      rows.push({
        stt: i + 1,
        phien: parsed[i].id ?? null,
        du_doan: null,
        ket_qua: actual,
        trang_thai: actual ? 'CHUA_DU_MAU' : 'DU_LIEU_LOI'
      });
      continue;
    }
    const past = parsed.slice(0, i).filter(x => x.result);
    const results = tuneSignalWeights(past, buildSignals(past));
    const ai = aiEnsemble(results, past.length);
    const prediction = ai.weakSignal ? null : ai.prediction;
    rows.push({
      stt: i + 1,
      phien: parsed[i].id ?? null,
      du_doan: prediction,
      xac_suat_tai: Number((ai.probabilityT * 100).toFixed(2)),
      do_tin_cay: `${ai.confidence}%`,
      ket_qua: actual,
      trang_thai: prediction == null ? 'BO_QUA' : (prediction === actual ? 'DUNG' : 'SAI')
    });
  }
  const scored = rows.filter(x => x.trang_thai === 'DUNG' || x.trang_thai === 'SAI');
  return {
    tong_phien: rows.length,
    da_danh_gia: scored.length,
    dung: scored.filter(x => x.trang_thai === 'DUNG').length,
    sai: scored.filter(x => x.trang_thai === 'SAI').length,
    accuracy: scored.length ? Number((scored.filter(x => x.trang_thai === 'DUNG').length / scored.length).toFixed(4)) : null,
    rows
  };
}

function fetchApi() {
  return new Promise((resolve, reject) => {
    const req = https.get(API_URL, { timeout: 15000 }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('API timeout')));
    req.on('error', reject);
  });
}

function makeResponse(newest, analysis) {
  return {
    id: AUTHOR_ID,
    phien_truoc: newest.id,
    xuc_xac: newest.dices || [],
    ket_qua: newest.resultTruyenThong,
    phien_nay: newest.id + 1,
    du_doan: analysis.weakSignal ? 'BO_QUA' : analysis.prediction,
    do_tin_cay: analysis.confidence + '%',
    xac_suat: analysis.scoreDetail,
    khoang_bat_dinh_tai: analysis.probabilityInterval,
    dong_thuan: analysis.agreement,
    mau_hieu_dung: analysis.effectiveN
  };
}

async function handlePrediction(req, res) {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];
    if (list.length < 12) return res.json({ id: AUTHOR_ID, error: 'Không đủ phiên' });
    const newest = list[0];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong, diem: item.point, id: item.id, dices: item.dices
    }));
    const analysis = analyzeCauAndDiem(history);
    if (analysis.error) return res.json({ id: AUTHOR_ID, error: analysis.error });
    const ledger = readLedger();
    const actual = toTX(newest).result === 'T' ? 'TAI' : toTX(newest).result === 'X' ? 'XIU' : null;
    if (actual && reconcileLedger(ledger, newest.id, actual)) writeLedger(ledger);
    appendPrediction(ledger, {
      targetSession: newest.id + 1,
      prediction: analysis.weakSignal ? null : analysis.prediction,
      probabilityTai: analysis.scoreDetail.TAI / 100,
      confidence: analysis.confidence,
      sourceSession: newest.id,
      createdAt: new Date().toISOString(),
      modelVersion: '6.3.0'
    });
    res.json(makeResponse(newest, analysis));
  } catch (e) {
    res.status(500).json({ id: AUTHOR_ID, error: e.message });
  }
}

app.get('/', handlePrediction);
app.get('/api/taixiumd5/lc79', handlePrediction);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'cdev-ai-suite',
    version: '6.3.0',
    algorithms: 45,
    routes: ['/', '/api/taixiumd5/lc79', '/debug', '/health', '/model', '/ketqua']
  });
});

app.get('/model', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong, diem: item.point, id: item.id, dices: item.dices
    }));
    const analysis = analyzeCauAndDiem(history);
    res.json({
      version: '6.3.0',
      history_len: history.length,
      ledger_metrics: ledgerMetrics(readLedger()),
      analysis,
      note: 'signalDiagnostics cho biết tín hiệu nào được giữ hoặc giảm trọng số'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ketqua', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];
    if (!list.length) return res.json({ id: AUTHOR_ID, error: 'Không có dữ liệu lịch sử' });
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong,
      diem: item.point,
      id: item.id,
      dices: item.dices
    }));
    const report = historicalResults(history, 12);
    const ledger = readLedger();
    res.json({
      id: AUTHOR_ID,
      route: '/ketqua',
      note: 'Mỗi dòng là một phiên; dự đoán chỉ dùng dữ liệu trước phiên đó',
      ledger_metrics: ledgerMetrics(ledger),
      live_ledger: ledger.slice(-100),
      ...report
    });
  } catch (e) {
    res.status(500).json({ id: AUTHOR_ID, error: e.message });
  }
});

app.get('/debug', async (req, res) => {
  try {
    const apiData = await fetchApi();
    const list = apiData.list || [];
    const history = [...list].reverse().map(item => ({
      result: item.resultTruyenThong, diem: item.point, id: item.id, dices: item.dices
    }));
    const analysis = analyzeCauAndDiem(history);
    res.json({ id: AUTHOR_ID, newest: list[0], analysis, history_len: history.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`CDEV AI SUITE 6.3 chạy tại port ${PORT}`);
});
