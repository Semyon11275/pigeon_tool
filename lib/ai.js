// Pigeon — AI 推理模块：Chinese-CLIP RN50（ONNX）
// 提供：文本/图像向量化、语义搜索、概念自动打标
'use strict';
const path = require('path');
const fs = require('fs-extra');

const CONTEXT = 52;           // 文本 token 长度（含 [CLS]/[SEP]）
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const DEFAULT_CONCEPTS = [
  '人物', '猫', '狗', '动物', '食物', '建筑', '室内', '风景', '海洋', '天空',
  '城市', '夜景', '截图', '插画', '网页设计', '海报', '排版', '图标', '摄影', '黑白',
  '极简', '复古', '科技感', '可爱', '图表', '手绘', '纹理', '抽象', '花卉', '树木',
  '道路', '汽车', '家具', '书籍',
];

// ---------- BERT 分词器（忠实移植 cn_clip/clip/bert_tokenizer.py） ----------
function loadVocab(vocabFile) {
  const lines = fs.readFileSync(vocabFile, 'utf8').split('\n');
  const vocab = {};
  lines.forEach((line, i) => { const t = line.replace(/\r/g, ''); if (t) vocab[t] = i; });
  return vocab;
}
function isSpace(ch) { return /[\s]/.test(ch); }
function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(ch);
}
function isChineseChar(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F) ||
    (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B920 && cp <= 0x2CEAF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}
function cleanText(text) {
  return text.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}
function tokenizeChineseChars(text) {
  let out = '';
  for (const ch of text) {
    if (isChineseChar(ch.codePointAt(0))) out += ' ' + ch + ' ';
    else out += ch;
  }
  return out;
}
function runStripAccents(text) {
  return text.normalize('NFD').replace(/[\p{M}]/gu, '');
}
function runSplitOnPunc(text) {
  const chars = [...text];
  const out = [];
  let startNewWord = true;
  for (const ch of chars) {
    if (isPunctuation(ch)) { out.push(ch); startNewWord = true; }
    else {
      if (startNewWord) out.push('');
      startNewWord = false;
      out[out.length - 1] += ch;
    }
  }
  return out;
}
function basicTokenize(text, lower = true) {
  text = tokenizeChineseChars(cleanText(text));
  let origTokens = text.split(/\s+/).filter(Boolean);
  const splitTokens = [];
  for (let token of origTokens) {
    if (lower) {
      token = token.toLowerCase();
      token = runStripAccents(token);
    }
    splitTokens.push(...runSplitOnPunc(token));
  }
  return splitTokens.filter(Boolean);
}
function wordpieceTokenize(vocab, text) {
  const output = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const chars = [...token];
    if (chars.length > 200) { output.push('[UNK]'); continue; }
    let isBad = false, start = 0;
    const subTokens = [];
    while (start < chars.length) {
      let end = chars.length, cur = null;
      while (start < end) {
        let substr = chars.slice(start, end).join('');
        if (start > 0) substr = '##' + substr;
        if (vocab[substr] != null) { cur = substr; break; }
        end--;
      }
      if (cur === null) { isBad = true; break; }
      subTokens.push(cur);
      start = end;
    }
    if (isBad) output.push('[UNK]'); else output.push(...subTokens);
  }
  return output;
}
function tokenizeText(vocab, text, contextLength = CONTEXT) {
  const tokens = [];
  for (const t of basicTokenize(text)) {
    for (const sub of wordpieceTokenize(vocab, t)) tokens.push(sub);
  }
  const ids = [vocab['[CLS]'], ...tokens.slice(0, contextLength - 2).map(t => vocab[t] ?? vocab['[UNK]']), vocab['[SEP]']];
  const arr = new BigInt64Array(contextLength);
  for (let i = 0; i < contextLength; i++) arr[i] = BigInt(i < ids.length ? ids[i] : 0);
  return arr;
}

// ---------- 推理会话 ----------
class AiRuntime {
  constructor(modelsDir) {
    this.modelsDir = modelsDir;
    this.textSession = null;
    this.visualSession = null;
    this.vocab = null;
    this.concepts = null;       // [{tag, vec}]
    this.vectors = {};          // itemId → [floats]
    this.vectorsFile = null;
    this.enabled = false;
  }
  available() {
    const has = (f) => { try { return fs.statSync(path.join(this.modelsDir, f)).size > 1024; } catch (e) { return false; } };
    return has('visual.onnx') && has('text.onnx');
  }
  async ensureModel() {
    if (this.textSession) return true;
    if (!this.available()) return false;
    // 打包态：原生模块在 app.asar.unpacked 里（asar 无法加载 .node/DLL），需兜底解析
    let ort;
    try {
      ort = require('onnxruntime-node');
    } catch (e1) {
      const unpacked = path.join(__dirname, '..', '..', 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node');
      ort = require(unpacked);
    }
    this.ort = ort;
    this.textSession = await ort.InferenceSession.create(path.join(this.modelsDir, 'text.onnx'));
    this.visualSession = await ort.InferenceSession.create(path.join(this.modelsDir, 'visual.onnx'));
    this.vocab = loadVocab(path.join(__dirname, '..', 'renderer', 'pigeon-vocab.txt'));
    if (!this.textSession || !this.visualSession) return false;
    await this.ensureConceptVecs();
    return true;
  }
  l2normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }
  async embedText(text) {
    if (!(await this.ensureModel())) throw new Error('AI 模型未就绪');
    const ids = tokenizeText(this.vocab, text);
    const feeds = { text: new this.ort.Tensor('int64', ids, [1, CONTEXT]) };
    const out = await this.textSession.run(feeds);
    const key = this.textSession.outputNames[0];
    const v = Array.from(out[key].data);
    return this.l2normalize(v);
  }
  // imageBuffer: 原图/缩略图字节（nativeImage 可解码的格式）
  async embedImageBuffer(buffer) {
    if (!(await this.ensureModel())) throw new Error('AI 模型未就绪');
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(buffer));
    if (img.isEmpty()) throw new Error('无法解码图像');
    const resized = img.resize({ width: 224, height: 224 });
    const bmp = resized.getBitmap();
    const w = 224, h = 224;
    const data = new Float32Array(1 * 3 * h * w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = bmp[i + 2] / 255, g = bmp[i + 1] / 255, b = bmp[i] / 255;
        data[0 * h * w + y * w + x] = (r - MEAN[0]) / STD[0];
        data[1 * h * w + y * w + x] = (g - MEAN[1]) / STD[1];
        data[2 * h * w + y * w + x] = (b - MEAN[2]) / STD[2];
      }
    }
    const out = await this.visualSession.run({ image: new this.ort.Tensor('float32', data, [1, 3, h, w]) });
    const key = this.visualSession.outputNames[0];
    return this.l2normalize(Array.from(out[key].data));
  }
  async ensureConceptVecs() {
    if (this.concepts) return this.concepts;
    this.concepts = DEFAULT_CONCEPTS.map(tag => ({ tag, vec: null }));
    for (const c of this.concepts) {
      c.vec = await this.embedText(c.tag);
    }
    return this.concepts;
  }
  cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }
  // ---------- 向量缓存 ----------
  loadVectors(root) {
    this.vectorsFile = path.join(root, 'ai-vectors.json');
    try { this.vectors = fs.readJsonSync(this.vectorsFile); } catch (e) { this.vectors = {}; }
    return this.vectors;
  }
  saveVectors() {
    if (this.vectorsFile) {
      try { fs.writeJsonSync(this.vectorsFile, this.vectors); } catch (e) {}
    }
  }
  async embedItem(root, item) {
    // 优先缩略图（小、快），没有则原文件
    const dir = path.join(root, 'images', item.id + '.info');
    let buf = null;
    const thumb = path.join(dir, 'thumbnail.png');
    const orig = path.join(dir, item.name + '.' + item.ext);
    if (fs.existsSync(thumb)) buf = await fs.readFile(thumb);
    else if (fs.existsSync(orig)) buf = await fs.readFile(orig);
    else return null;
    const vec = await this.embedImageBuffer(buf);
    this.vectors[item.id] = vec.map(x => Math.round(x * 1e5) / 1e5);
    return vec;
  }
  async autoTagItem(root, item, vec) {
    const v = vec || await this.embedItem(root, item);
    if (!v) return [];
    const concepts = await this.ensureConceptVecs();
    const scored = concepts.map(c => ({ tag: c.tag, score: this.cosine(v, c.vec) }))
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    const best = scored[0].score;
    const picked = scored.filter(s => s.score >= best - 0.02).slice(0, 3).map(s => s.tag);
    return picked;
  }
  async embedQuery(query) {
    return this.embedText(query);
  }
}

module.exports = { AiRuntime, tokenizeText, loadVocab, DEFAULT_CONCEPTS };
