/**
 * CDEV AI PREDICTOR V7 - DIVERSIFIED CORE
 *
 * Một file duy nhất gồm: chuẩn hóa dữ liệu; các họ Bayesian/Markov/streak;
 * walk-forward tuning; ensemble khử tương quan; calibration; uncertainty
 * interval; API tương thích server gốc.
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
// Ngưỡng edge tối thiểu để phát hành. 0.025 = lệch ít nhất 2.5 điểm phần trăm.
// Có thể tăng lên 0.05 nếu ưu tiên bỏ qua nhiều hơn; không nên đặt 0 để ép đoán.
const MIN_PUBLISH_EDGE = Math.max(0.01, Math.min(0.15,
  Number(process.env.MIN_PUBLISH_EDGE || 0.025)));
const MIN_HISTORY_REQUIRED = Math.max(5, Number(process.env.MIN_HISTORY_REQUIRED || 5));
const ALLOW_REMOTE_FALLBACK = process.env.ALLOW_REMOTE_FALLBACK === '1';
const COLLECT_INTERVAL_MS = Math.max(5000, Number(process.env.COLLECT_INTERVAL_MS || 15000));
const MAX_HISTORY_SESSIONS = Math.max(500, Number(process.env.MAX_HISTORY_SESSIONS || 5000));

const API_URL = process.env.API_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d';
const AUTHOR_ID = '@onlywhite27';
const LEDGER_FILE = process.env.PREDICTION_LEDGER || path.join(__dirname, 'prediction-ledger.json');
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'history-collected.json');

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

function readCollectedHistory() {
  try {
    const value = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(value) ? value.filter(x => x && x.id != null &&
      (x.resultTruyenThong === 'TAI' || x.resultTruyenThong === 'XIU')) : [];
  } catch (_) {
    return [];
  }
}

function chooseHistory(remoteList) {
  const local = readCollectedHistory();
  if (local.length >= MIN_HISTORY_REQUIRED) {
    return { list: local.slice().sort((a, b) => Number(a.id) - Number(b.id)), source: 'history-collected.json' };
  }
  return { list: Array.isArray(remoteList) ? remoteList : [], source: 'remote-api' };
}

function normalizeCollectedRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id ?? row.sessionId ?? row.phien ?? row.phien_truoc;
  const raw = String(row.resultTruyenThong ?? row.result ?? row.ket_qua ?? '').toUpperCase();
  const result = raw === 'TAI' || raw === 'TÀI' || raw === 'T' ? 'TAI' :
    raw === 'XIU' || raw === 'XỈU' || raw === 'X' ? 'XIU' : null;
  if (id == null || !result) return null;
  return { id: String(id), resultTruyenThong: result, dices: row.dices || null,
    point: Number.isFinite(Number(row.point ?? row.diem)) ? Number(row.point ?? row.diem) : null,
    collectedAt: new Date().toISOString() };
}

function writeCollectedHistory(rows) {
  const clean = rows.filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id)).slice(-MAX_HISTORY_SESSIONS);
  const temporary = `${HISTORY_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(temporary, HISTORY_FILE);
  return clean;
}

function extractCollectedRows(payload) {
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data)) return payload.data;
  return payload && (payload.id != null || payload.phien_truoc != null) ? [payload] : [];
}

async function collectHistoryOnce() {
  const payload = await fetchApi();
  const known = new Map(readCollectedHistory().map(x => [String(x.id), x]));
  for (const raw of extractCollectedRows(payload)) {
    const row = normalizeCollectedRow(raw);
    if (row) known.set(row.id, row);
  }
  const rows = writeCollectedHistory([...known.values()]);
  return { total: rows.length, tai: rows.filter(x => x.resultTruyenThong === 'TAI').length,
    xiu: rows.filter(x => x.resultTruyenThong === 'XIU').length };
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
    usable: data.length >= MIN_HISTORY_REQUIRED && valid === data.length && duplicateIds === 0
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

// CORE V7: chỉ giữ các họ tín hiệu khác nhau; không dùng ManualMD5X3
// trong backtest vì dữ liệu thủ công có thể chứa thông tin nhìn trước tương lai.
function signalGroup(name) {
  if (/Bayesian|MonteCarlo/.test(name)) return 'prior';
  if (/Markov|Cau/.test(name)) return 'transition';
  if (/RunLength|Entropy/.test(name)) return 'sequence';
  if (/WeightedMoving|Diem/.test(name)) return 'recency';
  return 'core';
}

function buildSignals(data) {
  const runs = extractRuns(data);
  const raw = [
    algoBayesian(data),
    algoMonteCarlo(data),
    algoRunLength(runs, data),
    algoEntropy(data),
    algoWeightedMoving(data),
    algoCauMarkov(data, runs),
    algoDiem(data)
  ];
  return raw.filter(x => x && Number.isFinite(Number(x.pT))).map(x => ({
    ...x,
    group: signalGroup(x.name),
    pT: clamp(Number(x.pT)),
    weight: Math.max(0.05, Number(x.weight) || 0.5)
  }));
}

// Walk-forward tuning: chỉ dùng phiên trước thời điểm đang đánh giá.
function tuneSignalWeights(data, results) {
  const stats = new Map();
  for (let i = 10; i < data.length; i++) {
    const actual = data[i].result === 'T' ? 1 : 0;
    for (const signal of buildSignals(data.slice(0, i))) {
      if (!stats.has(signal.name)) stats.set(signal.name, { loss: 0, brier: 0, wins: 0, n: 0 });
      const st = stats.get(signal.name);
      const p = clamp(signal.pT);
      st.loss += actual ? -Math.log(p) : -Math.log(1 - p);
      st.brier += (p - actual) ** 2;
      if ((p >= 0.5 ? 1 : 0) === actual) st.wins++;
      st.n++;
    }
  }
  for (const signal of results) {
    const st = stats.get(signal.name);
    if (!st || st.n < 5) {
      signal.weight *= 0.65;
      signal.status = 'LOW_SUPPORT';
      continue;
    }
    const accuracy = (st.wins + 1) / (st.n + 2);
    const edge = accuracy - 0.5;
    const avgLoss = st.loss / st.n;
    const avgBrier = st.brier / st.n;
    const accuracyFactor = Math.max(-0.8, Math.min(0.8, edge * 7));
    const lossFactor = Math.max(-0.25, Math.min(0.25, (Math.log(2) - avgLoss) * 1.5));
    signal.weight = Math.max(0.05, Math.min(2.0, signal.weight * Math.exp(accuracyFactor + lossFactor)));
    signal.tunedAccuracy = Number(accuracy.toFixed(4));
    signal.tunedEdge = Number(edge.toFixed(4));
    signal.tunedLogLoss = Number(avgLoss.toFixed(4));
    signal.tunedBrier = Number(avgBrier.toFixed(4));
    signal.tunedSamples = st.n;
    signal.status = edge > 0.01 && avgLoss < Math.log(2) ? 'KEEP' : 'DOWNWEIGHT';
  }
  return results;
}

// 10. Xác suất cấp cao: Bayesian Model Averaging + uncertainty.
function highLevelProbability(results, dataLength) {
  const valid = results.filter(r => Number.isFinite(Number(r.pT)));
  const groups = new Map();
  for (const r of valid) {
    const group = r.group || signalGroup(r.name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(r);
  }

  // Mỗi họ chỉ đóng góp một đại diện tổng hợp; không đếm cùng dữ liệu nhiều lần.
  const representatives = [];
  const groupSummaries = [];
  for (const [group, items] of groups) {
    const sorted = items.slice().sort((a, b) => b.weight - a.weight);
    const chosen = [];
    for (const item of sorted) {
      if (!chosen.some(x => Math.abs(x.pT - item.pT) < 0.025)) chosen.push(item);
      if (chosen.length >= 2) break;
    }
    const sumW = chosen.reduce((s, x) => s + x.weight, 0);
    const p = sumW ? chosen.reduce((s, x) => s + x.pT * x.weight, 0) / sumW : 0.5;
    const w = Math.min(1.25, Math.max(...chosen.map(x => x.weight)) * (1 + 0.12 * (chosen.length - 1)));
    representatives.push({ group, pT: p, weight: w });
    groupSummaries.push({ group, input: items.length, representatives: chosen.length, pT: Number(p.toFixed(4)) });
  }

  // Nếu các họ cho xác suất gần nhau, gom thành một cụm bằng chứng.
  const clusters = [];
  for (const item of representatives.sort((a, b) => b.weight - a.weight)) {
    let cluster = clusters.find(c => Math.abs(c.pT - item.pT) < 0.025);
    if (!cluster) {
      cluster = { pT: item.pT, weight: item.weight, count: 1 };
      clusters.push(cluster);
    } else {
      cluster.pT = (cluster.pT * cluster.count + item.pT) / (cluster.count + 1);
      cluster.count++;
      cluster.weight = Math.min(1.5, Math.max(cluster.weight, item.weight) * 1.10);
    }
  }

  let weightedP = 0, totalWeight = 0, agreeT = 0, agreeX = 0;
  for (const c of clusters) {
    weightedP += c.pT * c.weight;
    totalWeight += c.weight;
    if (c.pT >= 0.55) agreeT += c.weight;
    if (c.pT <= 0.45) agreeX += c.weight;
  }
  const rawP = totalWeight ? weightedP / totalWeight : 0.5;
  const agreement = Math.max(agreeT, agreeX) / Math.max(0.001, totalWeight);

  // Một Beta posterior duy nhất, prior yếu. Không shrink lần hai theo dataLength.
  const effectiveN = Math.max(8, Math.min(160, dataLength * (0.8 + 0.45 * agreement)));
  const prior = 2;
  const alpha = prior + rawP * effectiveN;
  const beta = prior + (1 - rawP) * effectiveN;
  let calibratedP = alpha / (alpha + beta);

  // Cân bằng hướng: không cho ensemble lệch quá xa chỉ vì một họ tín hiệu.
  const maxDirectionalEdge = 0.18;
  calibratedP = 0.5 + Math.max(-maxDirectionalEdge, Math.min(maxDirectionalEdge, calibratedP - 0.5));
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const margin = Math.min(0.49, 1.96 * Math.sqrt(variance));
  const edge = Math.abs(calibratedP - 0.5);

  return {
    pT: calibratedP,
    low: clamp(calibratedP - margin, 0, 1),
    high: clamp(calibratedP + margin, 0, 1),
    agreement,
    effectiveN,
    independentSignals: representatives.length,
    evidenceClusters: clusters.length,
    groupSummaries,
    confidence: Math.min(90, Math.round(50 + edge * 100 * (0.75 + agreement * 0.25))),
    direction: calibratedP >= 0.5 ? 'TAI' : 'XIU'
  };
}

// Ensemble V7 có trọng số đã tune và calibration
function aiEnsemble(results, dataLength) {
  const details = [];
  for (const r of results) {
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
    independentSignals: probability.independentSignals,
    evidenceClusters: probability.evidenceClusters,
    groupSummaries: probability.groupSummaries,
    details: details.join(', '),
    weakSignal: diff < MIN_PUBLISH_EDGE,
    minPublishEdge: MIN_PUBLISH_EDGE
  };
}

function signalDiagnostics(results) {
  return results.map(r => ({
    name: r.name,
    group: r.group || 'core',
    probabilityT: Number(clamp(r.pT).toFixed(4)),
    weight: Number((r.weight || 0).toFixed(4)),
    tunedLogLoss: r.tunedLogLoss ?? null,
    tunedBrier: r.tunedBrier ?? null,
    tunedAccuracy: r.tunedAccuracy ?? null,
    tunedEdge: r.tunedEdge ?? null,
    tunedSamples: r.tunedSamples ?? 0,
    status: r.tunedAccuracy == null ? 'LOW_SUPPORT' :
      (r.tunedEdge > 0.01 && r.tunedLogLoss < Math.log(2) ? 'KEEP' : 'DOWNWEIGHT')
  })).sort((a, b) => b.weight - a.weight);
}

function analyzeCauAndDiem(history) {
  if (!Array.isArray(history) || history.length < MIN_HISTORY_REQUIRED) return { error: `Cần ít nhất ${MIN_HISTORY_REQUIRED} phiên cho AI V7` };
  const parsed = history.map(toTX);
  const data = parsed.filter(x => x.result);
  if (data.length < MIN_HISTORY_REQUIRED) return { error: `Không đủ ${MIN_HISTORY_REQUIRED} phiên hợp lệ sau khi lọc dữ liệu lỗi` };
  const results = tuneSignalWeights(data, buildSignals(data));
  const ai = aiEnsemble(results, data.length);
  const onlineCalibration = calibrateWithLedger(ai.probabilityT, readLedger());
  if (onlineCalibration.applied) {
    ai.probabilityT = onlineCalibration.probabilityTai;
    ai.totalT = Math.round(ai.probabilityT * 100);
    ai.totalX = Math.round((1 - ai.probabilityT) * 100);
    ai.prediction = ai.probabilityT >= 0.5 ? 'TAI' : 'XIU';
    ai.weakSignal = Math.abs(ai.probabilityT - 0.5) < MIN_PUBLISH_EDGE;
    ai.confidence = ai.weakSignal ? Math.min(ai.confidence, 52) :
      Math.min(90, Math.round(50 + Math.abs(ai.probabilityT - 0.5) * 100));
    ai.calibrationSupport = onlineCalibration.support;
  }
  const quality = dataQuality(parsed);
  return {
    prediction: ai.prediction,
    confidence: ai.confidence,
    reason: `AI Predictor 7 | Tài ${ai.totalT}% Xỉu ${ai.totalX}% | ${ai.details || 'Tín hiệu yếu'}`,
    scoreDetail: { TAI: ai.totalT, XIU: ai.totalX },
    probabilityInterval: ai.intervalT,
    agreement: ai.agreement,
    effectiveN: ai.effectiveN,
    onlineCalibration: {
      applied: onlineCalibration.applied,
      support: onlineCalibration.support
    },
    weakSignal: ai.weakSignal,
    minPublishEdge: MIN_PUBLISH_EDGE,
    quality,
    signalDiagnostics: signalDiagnostics(results)
  };
}

// Đánh giá tuần tự từng phiên cũ. Phiên i chỉ được dự đoán bằng các phiên trước i,
// tuyệt đối không dùng chính kết quả của phiên i để tạo dự đoán.
function historicalResults(history, minHistory = MIN_HISTORY_REQUIRED) {
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
    const prediction = ai.prediction;
    rows.push({
      stt: i + 1,
      phien: parsed[i].id ?? null,
      du_doan: prediction,
      xac_suat_tai: Number((ai.probabilityT * 100).toFixed(2)),
      do_tin_cay: `${ai.confidence}%`,
      ket_qua: actual,
      trang_thai: prediction === actual ? 'DUNG' : 'SAI'
    });
  }
  const scored = rows.filter(x => x.trang_thai === 'DUNG' || x.trang_thai === 'SAI');
  const confusionMatrix = {
    actualTAI: { predictedTAI: 0, predictedXIU: 0 },
    actualXIU: { predictedTAI: 0, predictedXIU: 0 }
  };
  for (const row of scored) {
    const actualKey = row.ket_qua === 'TAI' ? 'actualTAI' : 'actualXIU';
    const predictedKey = row.du_doan === 'TAI' ? 'predictedTAI' : 'predictedXIU';
    confusionMatrix[actualKey][predictedKey]++;
  }
  const taiTotal = confusionMatrix.actualTAI.predictedTAI + confusionMatrix.actualTAI.predictedXIU;
  const xiuTotal = confusionMatrix.actualXIU.predictedTAI + confusionMatrix.actualXIU.predictedXIU;
  const recallTAI = taiTotal ? confusionMatrix.actualTAI.predictedTAI / taiTotal : null;
  const recallXIU = xiuTotal ? confusionMatrix.actualXIU.predictedXIU / xiuTotal : null;
  const availableRecalls = [recallTAI, recallXIU].filter(x => x != null);
  const predictedTAI = scored.filter(x => x.du_doan === 'TAI').length;
  const actualMajority = taiTotal >= xiuTotal ? 'TAI' : 'XIU';
  return {
    tong_phien: rows.length,
    da_danh_gia: scored.length,
    dung: scored.filter(x => x.trang_thai === 'DUNG').length,
    sai: scored.filter(x => x.trang_thai === 'SAI').length,
    accuracy: scored.length ? Number((scored.filter(x => x.trang_thai === 'DUNG').length / scored.length).toFixed(4)) : null,
    balanced_accuracy: availableRecalls.length === 2 ? Number(((recallTAI + recallXIU) / 2).toFixed(4)) : null,
    recall_tai: recallTAI == null ? null : Number(recallTAI.toFixed(4)),
    recall_xiu: recallXIU == null ? null : Number(recallXIU.toFixed(4)),
    confusion_matrix: confusionMatrix,
    predicted_tai_rate: scored.length ? Number((predictedTAI / scored.length).toFixed(4)) : null,
    predicted_xiu_rate: scored.length ? Number(((scored.length - predictedTAI) / scored.length).toFixed(4)) : null,
    actual_tai_rate: scored.length ? Number((taiTotal / scored.length).toFixed(4)) : null,
    actual_xiu_rate: scored.length ? Number((xiuTotal / scored.length).toFixed(4)) : null,
    majority_baseline_class: actualMajority,
    majority_baseline_accuracy: scored.length ? Number((Math.max(taiTotal, xiuTotal) / scored.length).toFixed(4)) : null,
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

function historySnapshot(apiData) {
  const chosen = chooseHistory(apiData && apiData.list);
  const list = chosen.list;
  const newest = chosen.source === 'history-collected.json' ? list[list.length - 1] : list[0];
  const ordered = chosen.source === 'history-collected.json' ? list : list.slice().reverse();
  const history = ordered.map(item => ({
    result: item.resultTruyenThong ?? item.result,
    diem: item.point ?? item.diem,
    id: item.id,
    dices: item.dices
  }));
  return { source: chosen.source, list, newest, history };
}

function nextSessionId(id) {
  const numeric = Number(id);
  if (Number.isSafeInteger(numeric)) return numeric + 1;
  return `${String(id)}_next`;
}

async function loadHistorySnapshot() {
  const local = readCollectedHistory();
  if (local.length >= MIN_HISTORY_REQUIRED || !ALLOW_REMOTE_FALLBACK) {
    return historySnapshot({ list: local });
  }
  return historySnapshot(await fetchApi());
}

function makeResponse(newest, analysis) {
  const nextId = nextSessionId(newest.id);
  return {
    id: AUTHOR_ID,
    phien_truoc: newest.id,
    xuc_xac: newest.dices || [],
    ket_qua: newest.resultTruyenThong,
    phien_nay: nextId,
    du_doan: analysis.prediction,
    do_tin_cay: analysis.confidence + '%',
    xac_suat: analysis.scoreDetail,
    khoang_bat_dinh_tai: analysis.probabilityInterval,
    dong_thuan: analysis.agreement,
    mau_hieu_dung: analysis.effectiveN
  };
}

async function handlePrediction(req, res) {
  try {
    const snapshot = await loadHistorySnapshot();
    const list = snapshot.list;
    if (list.length < MIN_HISTORY_REQUIRED) return res.json({ id: AUTHOR_ID, error: `Đang warm-up: cần ${MIN_HISTORY_REQUIRED} phiên thật` });
    const newest = snapshot.newest;
    const history = snapshot.history;
    const analysis = analyzeCauAndDiem(history);
    if (analysis.error) return res.json({ id: AUTHOR_ID, error: analysis.error });
    const ledger = readLedger();
    const actual = toTX(newest).result === 'T' ? 'TAI' : toTX(newest).result === 'X' ? 'XIU' : null;
    if (actual && reconcileLedger(ledger, newest.id, actual)) writeLedger(ledger);
    appendPrediction(ledger, {
      targetSession: nextSessionId(newest.id),
      prediction: analysis.prediction,
      probabilityTai: analysis.scoreDetail.TAI / 100,
      confidence: analysis.confidence,
      sourceSession: newest.id,
      createdAt: new Date().toISOString(),
      modelVersion: '7.0.0'
    });
    res.json({ ...makeResponse(newest, analysis), history_source: snapshot.source, history_count: history.length });
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
    version: '7.0.0',
    algorithms: 7,
    routes: ['/', '/api/taixiumd5/lc79', '/debug', '/health', '/model', '/ketqua']
  });
});

app.get('/model', async (req, res) => {
  try {
    const snapshot = await loadHistorySnapshot();
    const history = snapshot.history;
    const analysis = analyzeCauAndDiem(history);
    res.json({
      version: '7.0.0',
      history_len: history.length,
      history_source: snapshot.source,
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
    const snapshot = await loadHistorySnapshot();
    const list = snapshot.list;
    if (!list.length) return res.json({ id: AUTHOR_ID, error: 'Không có dữ liệu lịch sử' });
    const history = snapshot.history;
    const report = historicalResults(history, MIN_HISTORY_REQUIRED);
    const ledger = readLedger();
    res.json({
      id: AUTHOR_ID,
      route: '/ketqua',
      note: 'Mỗi dòng là một phiên; dự đoán chỉ dùng dữ liệu trước phiên đó',
      history_source: snapshot.source,
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
    const snapshot = await loadHistorySnapshot();
    const history = snapshot.history;
    const analysis = analyzeCauAndDiem(history);
    res.json({ id: AUTHOR_ID, newest: snapshot.newest, analysis, history_source: snapshot.source, history_len: history.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function startIntegrated() {
  let serverStarted = false;
  let collectTimer = null;
  let collecting = false;
  const startServer = () => {
    if (serverStarted) return;
    serverStarted = true;
    app.listen(PORT, () => {
      console.log(`CDEV AI PREDICTOR 7.0 chạy tại port ${PORT}`);
    });
  };
  const collectAndMaybeStart = async () => {
    if (collecting) return;
    collecting = true;
    try {
      const stats = await collectHistoryOnce();
      console.log(`history_collected=${stats.total}/${MIN_HISTORY_REQUIRED} tai=${stats.tai} xiu=${stats.xiu}`);
      // 5 phiên chỉ là điều kiện khởi động; collector vẫn phải chạy tiếp
      // để API luôn bám theo phiên mới nhất.
      if (stats.total >= MIN_HISTORY_REQUIRED) startServer();
    } catch (_) {
      console.log('history_collect_retry=true');
      if (readCollectedHistory().length >= MIN_HISTORY_REQUIRED) startServer();
    } finally {
      collecting = false;
    }
  };
  await collectAndMaybeStart();
  collectTimer = setInterval(collectAndMaybeStart, COLLECT_INTERVAL_MS);
}

startIntegrated().catch(() => {
  console.log('startup_waiting_for_history=true');
});
